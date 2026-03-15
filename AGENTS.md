# AGENTS.md

## Cursor Cloud specific instructions

This is a Node.js/TypeScript Express server (WhatsApp Practice Bot). The codebase is minimal — a single `src/index.ts` entry point.

### Running the dev server

```
npm run dev
```

Starts the Express server on port 3000 (configurable via `PORT` env var). Uses `ts-node --esm` to run TypeScript directly.

### Type checking

No dedicated lint script is configured. Use TypeScript compiler for type checking:

```
npx tsc --noEmit
```

### Tests

The `npm test` script is a placeholder (`echo "Error: no test specified" && exit 1`). No test framework is set up yet.

### Notes

- The project uses ES modules (`"type": "module"` in `package.json`) with `ts-node --esm`.
- A `node:DEP0180` deprecation warning about `fs.Stats` appears at startup — this is harmless and comes from `ts-node` internals, not from application code.
- No `.env` file is required for basic operation; `PORT` defaults to `3000`.
