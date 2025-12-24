# terrarium-core
AI LM Terrarium toy — dual front-ends plus a Fastify/Socket.io backend for multi-room LM agent play.

## Scope

### Terrain UI (Pixi)
- Renders a fixed-size 2D terrarium scene in a separate window (Vite + Svelte 5 + Pixi.js).
- Bots render as circles; speech appears briefly above them.
- Chat pane lists recent messages with optional room filter; rooms map to Socket.io rooms.
- Bots can move between rooms/locations; room history is stored in SQLite for context.

### Config UI (Svelte)
- Configure rooms (name, description, position/appearance in Pixi scene).
- Configure agents (persona/system prompts, provider/model selection, turn cadence min/max, context window per room).
- View full history by room and per-agent message history.

### Server
- Fastify + Socket.io; authoritative world state and scheduler.
- Non-blocking turn loop: scheduler enqueues turns, LM calls resolve async, responses patch state and broadcast.
- Persistence via SQLite (Kysely + better-sqlite3) for rooms, agents, messages, snapshots.
- LM providers are pluggable: OpenAI-compatible default plus Anthropic, Azure OpenAI, Gemini, LM Studio (each adapter in its own file). Env-based credentials.

## Stack
- Monorepo: pnpm workspaces + Turbo.
- Frontends: Vite + Svelte 5; Pixi.js in terrain app; Socket.io client on both.
- Backend: Fastify, Socket.io, pino logging, dotenv.
- Shared: zod schemas for contracts; Kysely + SQLite for persistence.
- TypeScript everywhere.

## Workspace layout
- apps/
	- server/ — Fastify + Socket.io backend, world scheduler loop.
	- ui-config/ — Vite + Svelte config UI (Svelte 5).
	- ui-terrain/ — Vite + Svelte + Pixi render UI (Svelte 5).
- packages/
	- shared/ — shared types/schemas (zod).
	- persistence/ — SQLite/Kysely adapter.
	- lm-providers/ — provider interfaces and individual adapters (openai, anthropic, azure-openai, gemini, lmstudio).
- data/ — SQLite database location (terrarium.db).

## Getting started
1) Install Node 18+ and pnpm (project metadata assumes pnpm@10.26.2).
2) Install deps: `pnpm install`
3) Approve native builds (needed for better-sqlite3/esbuild): `pnpm approve-builds`
4) Dev servers: `pnpm dev`
	 - Config UI: http://localhost:4173
	 - Terrain UI: http://localhost:4174
	 - API/socket: http://localhost:3000 (health at `/health`)
5) Build all: `pnpm build`

## Environment
- Create `.env` in root (loaded by server) for PORT, LOG_LEVEL, provider keys/URLs:
	- `PORT=3000`
	- `LOG_LEVEL=info`
	- `OPENAI_API_KEY=...`
	- `OPENAI_BASE_URL=...` (optional, OpenAI-compatible)
	- `ANTHROPIC_API_KEY=...`
	- `AZURE_OPENAI_ENDPOINT=...`, `AZURE_OPENAI_API_KEY=...`, `AZURE_OPENAI_DEPLOYMENT=...`
	- `GEMINI_API_KEY=...`
	- `LMSTUDIO_BASE_URL=http://localhost:1234/v1`

## Current placeholders
- LM provider calls are stubbed; wire real HTTP calls per adapter.
- Scheduler emits mock agent updates; needs integration with providers, persistence, and room/agent config API.
- UI is minimal scaffolding; hook up forms, room/agent CRUD, and live state feeds via Socket.io.