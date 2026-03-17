import axios from "axios";
import express, { type Request, type Response } from "express";
import dotenv from "dotenv";
import * as fs from "node:fs/promises";
import path from "node:path";

dotenv.config();

interface Poll {
  id: string;
  groupId: string;
  creatorId: string;
  options: string[];
  votes: Record<string, number[]>;
  createdAt: Date;
  isClosed: boolean;
}

interface IncomingTextMessage {
  from?: string;
  text?: {
    body?: string;
  };
  context?: {
    group_id?: string;
  };
}

interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: IncomingTextMessage[];
      };
    }>;
  }>;
}

interface PersistedPoll {
  id: string;
  groupId: string;
  creatorId: string;
  options: string[];
  votes: Record<string, number[]>;
  createdAt: string;
  isClosed: boolean;
}

interface PersistedState {
  pollsByGroupId: PersistedPoll[];
  pendingPollCreators: Record<string, string>;
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_MENTION = "@PracticeBot";
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v24.0";
const STATE_FILE_PATH =
  process.env.STATE_FILE_PATH || path.join(process.cwd(), ".bot-state.json");

const pollsByGroupId = new Map<string, Poll>();
const pendingPollCreators = new Map<string, string>();

app.use(express.json());

function generatePollId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function toPersistedPoll(poll: Poll): PersistedPoll {
  return {
    ...poll,
    createdAt: poll.createdAt.toISOString(),
  };
}

function toPoll(persistedPoll: PersistedPoll): Poll | null {
  const createdAt = new Date(persistedPoll.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return {
    ...persistedPoll,
    createdAt,
  };
}

async function persistState(): Promise<void> {
  const state: PersistedState = {
    pollsByGroupId: Array.from(pollsByGroupId.values()).map(toPersistedPoll),
    pendingPollCreators: Object.fromEntries(pendingPollCreators.entries()),
  };

  try {
    const dirPath = path.dirname(STATE_FILE_PATH);
    await fs.mkdir(dirPath, { recursive: true });

    const tempPath = `${STATE_FILE_PATH}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tempPath, STATE_FILE_PATH);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown persistence error";
    console.error(`Failed writing bot state: ${errorMessage}`);
  }
}

async function loadState(): Promise<void> {
  try {
    const fileContents = await fs.readFile(STATE_FILE_PATH, "utf8");
    const parsed = JSON.parse(fileContents) as Partial<PersistedState>;

    pollsByGroupId.clear();
    pendingPollCreators.clear();

    const persistedPolls = Array.isArray(parsed.pollsByGroupId)
      ? parsed.pollsByGroupId
      : [];
    for (const persistedPoll of persistedPolls) {
      if (
        persistedPoll &&
        typeof persistedPoll.id === "string" &&
        typeof persistedPoll.groupId === "string" &&
        typeof persistedPoll.creatorId === "string" &&
        Array.isArray(persistedPoll.options) &&
        persistedPoll.votes &&
        typeof persistedPoll.votes === "object" &&
        typeof persistedPoll.createdAt === "string" &&
        typeof persistedPoll.isClosed === "boolean"
      ) {
        const poll = toPoll({
          id: persistedPoll.id,
          groupId: persistedPoll.groupId,
          creatorId: persistedPoll.creatorId,
          options: persistedPoll.options.filter(
            (option): option is string => typeof option === "string",
          ),
          votes: Object.fromEntries(
            Object.entries(persistedPoll.votes).map(([voterId, voteIndexes]) => {
              const sanitizedVotes = Array.isArray(voteIndexes)
                ? voteIndexes
                    .map((voteIndex) =>
                      Number.isInteger(voteIndex) ? voteIndex : null,
                    )
                    .filter((voteIndex): voteIndex is number => voteIndex !== null)
                : [];
              return [voterId, sanitizedVotes];
            }),
          ),
          createdAt: persistedPoll.createdAt,
          isClosed: persistedPoll.isClosed,
        });
        if (poll) {
          pollsByGroupId.set(poll.groupId, poll);
        }
      }
    }

    if (
      parsed.pendingPollCreators &&
      typeof parsed.pendingPollCreators === "object"
    ) {
      for (const [groupId, creatorId] of Object.entries(
        parsed.pendingPollCreators,
      )) {
        if (typeof creatorId === "string") {
          pendingPollCreators.set(groupId, creatorId);
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    const errorMessage =
      error instanceof Error ? error.message : "Unknown state load error";
    console.error(`Failed loading bot state: ${errorMessage}`);
  }
}

async function sendMessage(to: string, text: string): Promise<void> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!token || !phoneNumberId || !to || !text) {
    return;
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;
  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown WhatsApp API error";
    console.error(`Failed sending WhatsApp message: ${errorMessage}`);
  }
}

async function sendToUser(userId: string, text: string): Promise<void> {
  await sendMessage(userId, text);
}

async function sendToGroup(groupId: string, text: string): Promise<void> {
  await sendMessage(groupId, text);
}

async function startPollCreation(userId: string, groupId: string): Promise<void> {
  if (!groupId) {
    await sendToUser(
      userId,
      "Polls can only be created from a group message context.",
    );
    return;
  }

  const activePoll = pollsByGroupId.get(groupId);
  if (activePoll && !activePoll.isClosed) {
    await sendToGroup(
      groupId,
      "There is already an active poll in this group. Close it before creating a new one.",
    );
    return;
  }

  pendingPollCreators.set(groupId, userId);
  await persistState();
  await sendToUser(
    userId,
    `Send options in this format:\n\n@PracticeBot options\nOption 1\nOption 2\nOption 3`,
  );
}

async function handleOptionsSubmission(
  userId: string,
  groupId: string,
  messageText: string,
): Promise<void> {
  if (!groupId) {
    await sendToUser(
      userId,
      "Options must be submitted from the same group where the poll was started.",
    );
    return;
  }

  const pendingCreatorId = pendingPollCreators.get(groupId);
  if (!pendingCreatorId) {
    await sendToUser(
      userId,
      "No pending poll setup found. Start with '@PracticeBot poll'.",
    );
    return;
  }

  if (pendingCreatorId !== userId) {
    await sendToUser(userId, "Only the poll creator can submit options.");
    return;
  }

  const lines = messageText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const options = lines.slice(1);

  if (options.length < 2) {
    await sendToUser(
      userId,
      "Please provide at least 2 options.\n\n@PracticeBot options\nOption 1\nOption 2",
    );
    return;
  }

  const poll: Poll = {
    id: generatePollId(),
    groupId,
    creatorId: userId,
    options,
    votes: {},
    createdAt: new Date(),
    isClosed: false,
  };

  pollsByGroupId.set(groupId, poll);
  pendingPollCreators.delete(groupId);
  await persistState();

  const optionsText = poll.options
    .map((option, index) => `${index + 1}) ${option}`)
    .join("\n");
  await sendToGroup(
    groupId,
    `Poll #${poll.id}\n${optionsText}\n\nVote using:\n@PracticeBot vote 1 3`,
  );
}

async function handleVote(
  userId: string,
  groupId: string,
  voteArgs: string[],
): Promise<void> {
  if (!groupId) {
    await sendToUser(userId, "Voting must be done from a group context.");
    return;
  }

  const poll = pollsByGroupId.get(groupId);
  if (!poll || poll.isClosed) {
    await sendToUser(userId, "No active poll found in this group.");
    return;
  }

  const voteIndexes = Array.from(
    new Set(
      voteArgs
        .map((arg) => Number.parseInt(arg, 10))
        .filter((voteNum) => Number.isFinite(voteNum))
        .map((voteNum) => voteNum - 1)
        .filter((voteIndex) => voteIndex >= 0 && voteIndex < poll.options.length),
    ),
  );

  if (voteIndexes.length === 0) {
    await sendToUser(
      userId,
      "Please provide valid vote numbers.\nExample: @PracticeBot vote 1 3",
    );
    return;
  }

  poll.votes[userId] = voteIndexes;
  await persistState();
  const selected = voteIndexes
    .map((index) => `${index + 1}) ${poll.options[index]}`)
    .join(", ");
  await sendToUser(userId, `Vote recorded: ${selected}`);
}

async function handleResults(userId: string, groupId: string): Promise<void> {
  if (!groupId) {
    await sendToUser(userId, "Results are available in group context only.");
    return;
  }

  const poll = pollsByGroupId.get(groupId);
  if (!poll) {
    await sendToUser(userId, "No poll found for this group.");
    return;
  }

  const counts = new Array<number>(poll.options.length).fill(0);
  for (const voteIndexes of Object.values(poll.votes)) {
    for (const voteIndex of voteIndexes) {
      if (voteIndex >= 0 && voteIndex < counts.length) {
        counts[voteIndex] = (counts[voteIndex] ?? 0) + 1;
      }
    }
  }

  const lines = poll.options.map(
    (option, index) => `${index + 1}) ${option} - ${counts[index]} votes`,
  );
  await sendToGroup(groupId, `Results:\n${lines.join("\n")}`);
}

async function handleConfirm(
  userId: string,
  groupId: string,
  selectedOptionArg: string | undefined,
): Promise<void> {
  if (!groupId) {
    await sendToUser(userId, "Confirm must be run from a group context.");
    return;
  }

  const poll = pollsByGroupId.get(groupId);
  if (!poll || poll.isClosed) {
    await sendToUser(userId, "No active poll available to confirm.");
    return;
  }

  if (poll.creatorId !== userId) {
    await sendToUser(userId, "Only the poll creator can confirm the practice slot.");
    return;
  }

  const selectedOption = Number.parseInt(selectedOptionArg ?? "", 10);
  const selectedIndex = selectedOption - 1;
  if (!Number.isFinite(selectedOption) || selectedIndex < 0 || selectedIndex >= poll.options.length) {
    await sendToUser(userId, "Please confirm with a valid option number. Example: @PracticeBot confirm 2");
    return;
  }

  poll.isClosed = true;
  await persistState();
  await sendToGroup(
    groupId,
    `Practice confirmed: ${poll.options[selectedIndex]}\n\nPoll closed.`,
  );
}

async function handleIncomingTextMessage(msg: IncomingTextMessage): Promise<void> {
  try {
    const userId = msg.from ?? "";
    const groupId = msg.context?.group_id ?? "";
    const messageText = msg.text?.body?.trim() ?? "";
    if (!userId || !messageText || !messageText.includes(BOT_MENTION)) {
      return;
    }

    const lines = messageText.split(/\r?\n/);
    const firstLine = lines[0] ?? "";
    const commandLine = firstLine.replace(/@PracticeBot/i, "").trim();
    const [commandRaw, ...commandArgs] = commandLine.split(/\s+/).filter(Boolean);
    const command = commandRaw?.toLowerCase();
    if (!command) {
      return;
    }

    switch (command) {
      case "poll":
        await startPollCreation(userId, groupId);
        return;
      case "options":
        await handleOptionsSubmission(userId, groupId, messageText);
        return;
      case "vote":
        await handleVote(userId, groupId, commandArgs);
        return;
      case "results":
        await handleResults(userId, groupId);
        return;
      case "confirm":
        await handleConfirm(userId, groupId, commandArgs[0]);
        return;
      default:
        await sendToUser(
          userId,
          "Unknown command. Use poll, options, vote, results, or confirm.",
        );
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown handler error";
    console.error(`Failed handling incoming message: ${errorMessage}`);
  }
}

app.get("/", (_req: Request, res: Response) => {
  res.send("WhatsApp Practice Bot is running");
});

app.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN;

  if (
    mode === "subscribe" &&
    typeof token === "string" &&
    typeof challenge === "string" &&
    verifyToken &&
    token === verifyToken
  ) {
    res.status(200).send(challenge);
    return;
  }

  res.sendStatus(403);
});

app.post("/webhook", async (req: Request, res: Response) => {
  try {
    const payload = (req.body as WebhookPayload | undefined) ?? {};
    const messages =
      payload.entry?.flatMap((entry) =>
        entry.changes?.flatMap((change) => change.value?.messages ?? []) ?? [],
      ) ?? [];

    for (const msg of messages) {
      await handleIncomingTextMessage(msg);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown webhook error";
    console.error(`Failed processing webhook payload: ${errorMessage}`);
  }

  res.sendStatus(200);
});

async function bootstrap(): Promise<void> {
  await loadState();
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

void bootstrap();
