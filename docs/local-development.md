# Terrarium Core local development

## Start and validate

Use Node 24 (tested with 24.15.0), pnpm 10.26.2, and Windows for ChatGPT credential storage. From the repository root:

```sh
pnpm install
pnpm dev
```

Development builds the shared, persistence, and model-provider packages before starting watchers, the server, and the web interface at `http://localhost:4173`. It works without pre-existing compiled output. Health: `http://127.0.0.1:3000/health`. Start optional terrain separately with `pnpm dev:terrain` at `http://localhost:4174`.

```sh
pnpm build
pnpm check
pnpm test
```

Build compiles all six packages; check runs Svelte/TypeScript checks for both frontends. Tests cover contracts, migrations, persistence, sockets, scheduling, and fake provider responses. Automated tests make no real model calls. If an existing installation reports a SQLite Node ABI mismatch after changing Node, run `pnpm --filter @terrarium/persistence rebuild better-sqlite3`.

## Paths and local access

The server loads root `.env` regardless of working directory. It uses root `data/terrarium.db`. If only legacy `apps/server/data/terrarium.db` exists, first startup copies it using SQLite backup before migrating the copy. The original remains unchanged. Existing canonical data takes precedence. An interrupted `.migrating` backup causes startup to fail rather than overwrite it.

`DATABASE_PATH` optionally selects a database, resolving relative paths from the repository root and disabling legacy copying. `LOG_LEVEL` controls logging. `PORT` defaults to 3000; frontend proxies target that default port. These environment values pass through the development runner. Server host remains `127.0.0.1`.

Accepted UI origins are `http://localhost:4173`, `http://127.0.0.1:4173`, `http://localhost:4174`, and `http://127.0.0.1:4174`. Socket handshakes also require localhost/127.0.0.1 as host. This is a local origin restriction, not multi-user authentication.

SQLite files and sidecars, Vite caches, and compiled output are ignored. Previously tracked runtime files were removed from Git tracking while retaining local files. Do not distribute configuration through database files.

## Connect ChatGPT and run a conversation

1. Open the web interface in your ChatGPT browser. Choose **Connect ChatGPT**, then **Continue to ChatGPT sign-in**; complete sign-in and plan-usage consent.
2. Wait for Connected. Model discovery fills suggestions; `gpt-6-luna` is the initial selection. A listed model still requires access through the signed-in account.
3. Create or edit rooms. A fresh database initializes five rooms and no agents.
4. Create an agent with a name, instructions, current room, model, cadence, and context limit of 1–50 messages. The form initially suggests 10–30 seconds and 50 messages. Enable the agent when ready. Saving configuration never automatically starts the run.
5. Choose **Start**. Agents propose `speak`, `move`, or `wait`; the server validates and applies actions. Saved speech shows speaker names and timestamps.
6. **Pause** stops new turns and finishes active turns. **Resume** continues scheduling. **Stop** cancels active work and discards late results. Disable/edit an agent to invalidate its old turn.

Sign-in uses an ephemeral loopback callback and a ten-minute timeout. If opened in the wrong browser, restart the server to cancel the attempt, then begin from the intended browser. Credentials live under `%LOCALAPPDATA%/TerrariumCore/credentials`, encrypted with an AES key protected by Windows DPAPI for the current user. Directory access is restricted to that user and SYSTEM. Terrarium does not read another application's credentials or accept API keys. ChatGPT plan-usage tokens authorize Responses requests. See [authentication provenance](authentication-provenance.md).

The scheduler permits four requests and one active turn per agent. Attempts time out after 60 seconds, retrying at most twice with 1/2-second backoff. Exhausted failures remain visible and schedule another turn after the configured cadence. State-read failures pause with a recovery message. Restart starts stopped. Context uses only the current room, including history before arrival; the UI's room selection does not affect agent knowledge.

## Export and import configuration

Use **Export configuration** in **Configuration files** to download `terrarium-config.json`. The readable UTF-8 file contains `format: "terrarium-config"`, `version: 1`, `rooms`, and `agents`. It exports a consistent snapshot of all saved room and agent settings, including stable IDs, instructions, model, interval values in milliseconds, context limits, enabled flags and current room assignments. Conversation history, ChatGPT credentials, run state and internal agent revisions are excluded.

Choose a JSON file to validate and preview each room/agent addition or update. IDs determine identity: matching IDs are updated, new IDs are created, and saved entries absent from the file remain. Names are editable labels, not matching keys. Every entry needs an ID. Agent room references may point to either a room in the file or an existing saved room. Unknown references, duplicate IDs, unsupported versions, extra fields and invalid settings are rejected with details. Files and their formatted representation must fit within 512 KiB, below the existing socket transport limit.

Choose **Stop**, then **Apply import**. All changes commit in one database transaction; a failed write rolls the entire import back. Enabled flags are preserved, but import never starts a run. Start and competing room/agent writes are blocked while an import is being applied. If the file or saved configuration has changed since preview, preview it again. The UI invalidates previews after a world update or disconnection. Once imported, choose **Start** when ready.

## Model output and diagnostics

Agent turns use Responses `text.format` with `type: "json_schema"` and `strict: true` through the existing ChatGPT sign-in token. The response is wrapped as `{"action":{"type":"speak","message":"..."}}`, `{"action":{"type":"move","roomId":"..."}}`, or `{"action":{"type":"wait"}}`. The wrapper permits a nested choice while keeping the schema root an object. Every object rejects extra fields. Speech requires non-whitespace content and an 8,000-character maximum. Local validation and world checks still run before applying the action; a valid shape alone cannot establish that a destination exists or a turn is current.

This route was verified with real `gpt-6-luna` calls using Terrarium's existing ChatGPT connection. No additional credentials or dependencies are needed. Models that reject the schema produce an explicit provider error; Terrarium does not silently fall back to unconstrained text. See the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs) and [ChatGPT token-sharing inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

The stream reader waits for successful completion and uses the final assistant message, separating commentary from action text. ChatGPT plan streams can leave `response.completed.output` empty, so completed output-item events are retained. Multiple final messages, refusals, unsupported tool calls and incomplete streams fail explicitly.

An exhausted turn shows the attempt count and specific failure in the agent's existing status area. Invalid JSON and action-schema failures include the model, failing fields, response/request IDs when available, output length and a preview capped at 240 characters. Application failures identify the proposed action and reason. Provider errors include HTTP status or stream event, bounded error code/message/parameter/reason, and available IDs. Credentials and complete room histories are not included. These are current run diagnostics, not a persistent error archive; starting the next turn or choosing Stop clears the error.

## Socket contracts

Commands on `/config` acknowledge `{ ok: true, value }` or `{ ok: false, error }`:

| Command          | Input / result                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config:message` | `{ roomId, message }`; trimmed length 1–8,000; returns saved message.                                                                                                    |
| `history:get`    | `{ roomId, before?, after? }`; cursors `{ createdAt, id }`; choose before or after; returns `{ messages, hasMore }`.                                                     |
| `rooms:save`     | `{ id?, name, description }`; omit ID to create; returns saved configuration.                                                                                            |
| `agents:save`    | `{ id?, name, instructions, roomId, provider: 'chatgpt', model, enabled, minIntervalMs, maxIntervalMs, contextMessageLimit }`; returns saved configuration and revision. |
| `config:export`  | `{}`; returns the versioned configuration file object. |
| `config:preview` | Configuration file object; validates references and returns `{ token, rooms, agents }`, each preview entry containing `{ id, name, operation: 'add' \| 'update' }`. |
| `config:import`  | `{ configuration, previewToken }`; requires a stopped run and a current preview; atomically merges configuration and returns the applied preview. |
| `run:control`    | `'start'`, `'pause'`, `'stop'`; returns run state.                                                                                                                       |
| `auth:login`     | `{}`; returns browser sign-in URL. Credentials stay on the server.                                                                                                       |
| `auth:models`    | `{}`; returns visible model slugs.                                                                                                                                       |

`world:state`, `run:state`, and `auth:state` synchronize the operator UI. Both namespaces receive `conversation:message` after persistence, carrying `{ id, roomId, agentId, speaker, createdAt, content }`. Humans use agent ID `config-ui` and speaker `Human`. `/terrain` also receives `rooms:list`.

History pages contain up to 100 messages ordered oldest to newest by saved timestamp and ID. Initially select the latest page; `before` retrieves older pages; `after` retrieves missed messages forward. The client merges by ID, freezes reconnect cursors before live events arrive, and follows all forward pages. New timestamps advance monotonically to prevent same-millisecond inserts falling behind a cursor.
