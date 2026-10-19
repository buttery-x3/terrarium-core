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
4. Create an agent with a name, instructions, current room, model, cadence, and personal memory limit of 1–50 observations. The form initially suggests 10–30 seconds and 30 observations. Enable the agent when ready. Saving configuration never automatically starts the run.
5. Choose **Start**. Agents propose `speak`, `move`, `emote`, or `eat`; disabling emotes substitutes silent `wait`. The server validates and applies one action. Speech and italic activity show actor identity and timestamps. Eating requires enabled energy and a food-source current room.
6. **Pause** stops new turns and finishes active turns. **Resume** continues scheduling. **Stop** cancels active work and discards late results. Disable/edit an agent to invalidate its old turn.

Sign-in uses an ephemeral loopback callback and a ten-minute timeout. If opened in the wrong browser, restart the server to cancel the attempt, then begin from the intended browser. Credentials live under `%LOCALAPPDATA%/TerrariumCore/credentials`, encrypted with an AES key protected by Windows DPAPI for the current user. Directory access is restricted to that user and SYSTEM. Terrarium does not read another application's credentials or accept API keys. ChatGPT plan-usage tokens authorize Responses requests. See [authentication provenance](authentication-provenance.md).

The scheduler permits four requests and one active turn per agent. Attempts time out after 60 seconds, retrying at most twice with 1/2-second backoff. Exhausted failures remain visible and schedule another turn after the configured cadence. State-read failures pause with a recovery message. Restart starts stopped. Context uses personal observations across rooms, never the room archive; the UI's room selection does not affect agent knowledge.

## Delete an agent

In **Agents**, choose **Delete [agent name]** beside its **Edit** button. The confirmation names the agent and explains that its settings will be permanently removed while existing messages are kept. Choose **Permanently delete agent** to proceed or **Cancel deletion** to keep it.

Deletion works while stopped, running or paused. It cancels the selected agent's active turn, discards late replies and removes its scheduled activity without stopping other agents. Saved conversation messages keep their original speaker names and remain part of room history. The agent list refreshes and any open edit form for the removed agent resets. Other rooms, agents and settings remain unchanged. A disconnected browser or changed agent invalidates its pending confirmation.

Invalid IDs, already-deleted agents and failed writes return errors. Deletion is blocked while a configuration import is in progress. Future exports exclude deleted agents; explicitly importing an older configuration containing their IDs can create them again. No migration or extra dependency is required.

## Export and import configuration

Use **Export configuration** in **Configuration files** to download `terrarium-config.json`. The readable UTF-8 file contains `format: "terrarium-config"`, `version: 3`, `rooms`, `agents`, and `settings`. It exports a consistent snapshot of stable IDs, personality `instructions`, motivations, intention, model, intervals in milliseconds, memory limits, enabled flags, room assignments, food-source flags, energy policy, activity toggles, shared prompts and diagnostic policy. Personal memories, conversation history, credentials, current energy, diagnostic records, run state and internal revisions are excluded.

Choose a JSON file to validate and preview each room/agent addition or update. IDs determine identity: matching IDs are updated, new IDs are created, and saved entries absent from the file remain. Names are editable labels, not matching keys. Every entry needs an ID. Agent room references may point to either a room in the file or an existing saved room. Unknown references, duplicate IDs, unsupported versions, extra fields and invalid settings are rejected with details. Files and their formatted representation must fit within 512 KiB, below the existing socket transport limit.

Choose **Stop**, then **Apply import**. All changes commit in one database transaction; a failed write rolls the entire import back. Enabled flags are preserved, but import never starts a run. Start and competing room/agent writes are blocked while an import is being applied. If the file or saved configuration has changed since preview, preview it again. The UI invalidates previews after a world update or disconnection. Once imported, choose **Start** when ready.

## Export conversations

Choose **Export conversations** under **Conversations** to download `terrarium-conversations.md`. One readable UTF-8 Markdown file contains a heading for every room, with all saved activity ordered oldest first by timestamp and ID. Speech includes its saved speaker name, timestamp and full text as a blockquote. Emotes and movement appear as italic activity with actor, type, timestamp and record ID. Multiline speech is retained, empty rooms show **No messages**, and deleted agents' past activity keeps its original actor name.

The export reads all history, including messages beyond the page currently displayed. Room names and messages come from one consistent database snapshot, so exporting works while stopped, running or paused without changing the run or saved data. Messages saved after that snapshot appear in the next export. Room/agent settings and credentials are excluded. The file is a conversation transcript; configuration import continues to accept only configuration JSON.

## Clear conversation history

Choose **Stop**, then use **Clear saved messages from** under **Conversations** to select **Current room** or **All rooms**. Choose **Clear conversation** to review the scope, then **Permanently delete messages** to confirm, or **Cancel clearing** to keep the conversation. Deletion cannot be undone. Room and agent settings, including enabled flags and room assignments, remain unchanged.

Clearing deletes saved human and agent messages in one transaction. Subsequent agent turns read the remaining history, so deleted messages no longer enter their conversation context. Stop invalidates pending turns; late replies cannot restore the cleared conversation. The server rejects clearing while running or paused and blocks Start, new human messages and another clear while deletion is in progress. A failed deletion rolls back and emits no clear notification.

Connected config and terrain views reset affected rooms immediately. Pending history responses are discarded for cleared rooms. Reconnecting refreshes the latest saved page instead of retaining potentially deleted cached messages; **Load older messages** still retrieves older saved pages. Clearing does not erase personality instructions or room descriptions.

## Model output and diagnostics

Agent turns use Responses `text.format` with `type: "json_schema"` and `strict: true` through the existing ChatGPT sign-in token. The response wraps one `action` (speak, move, wait or eat) and a nullable `intention`, for example `{"action":{"type":"eat"},"intention":null}`. The wrapper permits a nested choice while keeping the schema root an object. Every object rejects extra fields. Speech requires non-whitespace content and an 8,000-character maximum. Local validation and world checks still run before applying the action; a valid shape alone cannot establish that a destination exists or a turn is current.

This route was verified with real `gpt-6-luna` calls using Terrarium's existing ChatGPT connection. No additional credentials or dependencies are needed. Models that reject the schema produce an explicit provider error; Terrarium does not silently fall back to unconstrained text. See the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs) and [ChatGPT token-sharing inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

The stream reader waits for successful completion and uses the final assistant message, separating commentary from action text. ChatGPT plan streams can leave `response.completed.output` empty, so completed output-item events are retained. Multiple final messages, refusals, unsupported tool calls and incomplete streams fail explicitly.

An exhausted turn shows the attempt count and specific failure in the agent's existing status area. Invalid JSON and action-schema failures include the model, failing fields, response/request IDs when available, output length and a preview capped at 240 characters. Application failures identify the proposed action and reason. Provider errors include HTTP status or stream event, bounded error code/message/parameter/reason, and available IDs. Credentials and complete room histories are not included. The transient run status clears on the next turn or Stop; durable attempt records remain in Decision diagnostics until explicitly cleared.

## Socket contracts

Commands on `/config` acknowledge `{ ok: true, value }` or `{ ok: false, error }`:

| Command          | Input / result                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config:message` | `{ roomId, message }`; trimmed length 1–8,000; returns saved message.                                                                                                    |
| `history:get`    | `{ roomId, before?, after? }`; cursors `{ createdAt, id }`; choose before or after; returns `{ messages, hasMore }`.                                                     |
| `history:export` | `{}`; returns one Markdown string containing every room and all saved messages from a consistent snapshot; available in any run state. |
| `history:clear`  | `{ scope: 'room', roomId }` or `{ scope: 'all' }`; requires a stopped run; returns `{ roomIds, deletedMessages }` after deletion commits. |
| `rooms:save`     | `{ id?, name, description }`; omit ID to create; returns saved configuration.                                                                                            |
| `agents:save`    | `{ id?, name, instructions, roomId, provider: 'chatgpt', model, enabled, minIntervalMs, maxIntervalMs, contextMessageLimit }`; returns saved configuration and revision. |
| `agents:delete`  | `{ id }`; deletes one agent, cancels its active turn and preserves messages; returns `{ id }` and publishes updated world/run state. Blocked during configuration import. |
| `config:export`  | `{}`; returns the versioned configuration file object. |
| `config:preview` | Configuration file object; validates references and returns `{ token, rooms, agents, defaults, settingsChanged }`, each entity entry containing `{ id, name, operation: 'add' \| 'update' }`. |
| `config:import`  | `{ configuration, previewToken }`; requires a stopped run and a current preview; atomically merges configuration and returns the applied preview. |
| `run:control`    | `'start'`, `'pause'`, `'stop'`; returns run state.                                                                                                                       |
| `auth:login`     | `{}`; returns browser sign-in URL. Credentials stay on the server.                                                                                                       |
| `auth:models`    | `{}`; returns visible model slugs.                                                                                                                                       |

`world:state`, `run:state`, and `auth:state` synchronize the operator UI. Both namespaces receive `conversation:message` after persistence, carrying `{ id, roomId, agentId, speaker, createdAt, content, type }`, where type is `speak`, `emote`, `arrival` or `departure`, and `conversation:cleared` carrying `{ roomIds, deletedMessages }` after deletion commits. Humans use agent ID `config-ui` and speaker `Human`. `/terrain` also receives `rooms:list` and supports `history:get` to restore its latest room activity on reconnect.

History pages contain up to 100 messages ordered oldest to newest by saved timestamp and ID. Initially select the latest page; `before` retrieves older pages; `after` remains available for forward retrieval. The client merges live delivery and history by ID. On reconnect, it discards local history and pagination caches and fetches the latest page so offline deletion is reflected. Cleared rooms invalidate pending history requests; stale acknowledgements cannot repopulate them. New timestamps advance monotonically while messages remain saved to prevent same-millisecond inserts falling behind a cursor.

## FLAME-146 energy, profiles and prompting

Mark any room **Provides unlimited food** in its editor. Names and IDs have no special meaning; several food sources may coexist. Then, while stopped, enable energy under **Shared behaviour and energy**. Enabling/starting without a food source, or removing the last source while enabled, is rejected.

Defaults: energy is disabled; initial/maximum 100; depletion 5 points per running minute; low energy at 25 or below; meals fill to maximum. Without meals, a full agent becomes low after 15 running minutes and reaches zero after 20. Initial energy applies to newly created agents. A maximum below an existing current value is rejected. Zero clamps at zero and does not prohibit speaking, movement, eating or waiting.

Only enabled agents drain energy while the simulation runs. Passive decay uses elapsed time and is checkpointed on scheduler ticks, action/context boundaries and lifecycle changes; retries and cadence do not add charges. Pause freezes decay immediately while allowing already-active turns and their existing bounded retries to finish. An active meal may refill energy during Pause. Stop cancels pending work and preserves energy; restart starts stopped without offline catch-up or refill. An abrupt crash preserves the last committed checkpoint, so the uncommitted fraction of a running interval is not recovered offline.

Personality remains the original `instructions` field, preserved verbatim. **Motivations and preferences** is separate text (up to 8,000 characters); **Current intention** is an optional operator-configured aim (up to 1,000). Neither is an accumulating boredom meter. Agents may return an optional self-report of up to 240 characters for a single decision. It appears only in diagnostics and is never carried into future prompts. Personal memory contains observed activity only, with no private notes or relationship tracking.

The seven shared prompt fields are assembled in this order: role/framing, profile interpretation, action selection, energy/food guidance, reminders, personal observations, and emotes. They are followed by resolved local data and enforced protocol constraints. Defaults support self-direction, choosing an action before speech, prioritising food when low, and quiet behaviour without a compulsory novelty or conversation objective. Each field has a Restore default button; saving requires Stop. Required missing/blank fields fail validation; reminders may explicitly be empty. There is no hidden replacement prompt.

**Preview saved prompt** displays the saved instructions in request order, personal memory with original metadata, configured schema and complete provider-body preview. It performs no model request, creates no diagnostic turn and mutates no world state. The snapshot includes own profile and energy/activity rules, current room, locally present names/IDs and the public room directory with food flags. Remote occupancy, other agents' private profiles, unobserved transcripts and operator logs are excluded. Earlier room history is never supplied to a new arrival.

The provider schema now also accepts `{"action":{"type":"eat"},"intention":null}`. Provider requests require the nullable `intention` field; local validation continues to accept older action-only responses. The server authorises exactly one action, checks current location/capability when applying eating, and records rejected attempts. Saying “I ate” is only speech. A move to the same room is recorded as an applied no-op. Eating fills current energy transactionally and generates activity, not fabricated speech.

## Persistent decision diagnostics

**Decision diagnostics** has filters for agent ID (including deleted IDs), decision room, action, outcome and scheduled time. It loads 50 summary rows per page; details are fetched on expansion. Attempt 0 is the scheduling/turn summary; attempts 1–3 share its turn ID. A scheduled/cancelled-before-start entry has no model decision. Failures are never represented as waits.

Each attempt starts durably before the provider is called. Its saved data includes the configured model, settings version and agent revision, exact local context, exact submitted provider body (`instructions`, `input`, model, streaming/storage flags and output schema), final action text, parsed proposal, optional self-report, available request/response IDs, result and timings. Applied actions include source/destination, real-movement versus no-op, saved speech message ID and energy seen/before/after plus passive depletion. Notification failure keeps the committed action applied and prevents retrying it. Provider, timeout, parse, schema, world-validation, persistence, stale, cancelled and interrupted outcomes remain separate.

Only the application-controlled request body and relevant action/error fields are captured. Authorization headers, access/refresh tokens, credential stores and authentication payloads never enter diagnostics. Provider-internal instructions and hidden reasoning are not visible. The existing 4 MiB provider stream limit remains; incomplete/error captures are explicitly marked partial. Successful payloads and final outputs are not silently truncated.

The default diagnostic budget is 256 MiB, configurable from 32 to 16,384 MiB. This measures saved JSON payload bytes plus a 1 KiB row allowance, not total SQLite disk usage. Each started attempt reserves 8 MiB before a request is admitted. The run pauses visibly if the budget or durable logging cannot be satisfied; no automatic pruning occurs. A request whose payload/evidence exceeds its reservation is rejected before submission/application and the run pauses. Resolve storage failures, or choose Stop and increase the budget or export/clear diagnostics, then Start. Previously unfinished rows are marked interrupted on server startup; successful evidence is retained.

**Export filtered diagnostics** downloads JSON using bounded retrieval pages. Records already passed by a running export can subsequently finish; Stop first for a quiescent export. **Clear diagnostics** requires Stop, finished cancellation bookkeeping and explicit confirmation, and deletes all stored diagnostic snapshots. It leaves conversation history and configuration intact. Conversation clearing and agent deletion retain diagnostics, including saved names and copied conversation text; the conversation-clear confirmation states this explicitly. Downloaded files are independent copies and are never removed by either clear operation.

## Configuration version 1 compatibility and new commands

Version-1 files remain importable. Existing food flags, motivations, intentions and shared settings are preserved when absent from the older file. New rooms default to non-food sources; new agents receive empty motivation/intention sections and the configured initial energy. The preview lists new defaults, additions/updates and whether shared settings change. Version 2 requires complete shared settings, food flags and profile sections. Unsupported versions and unknown fields fail validation. Imports preserve current energy for existing agents, omitted entities and history, apply atomically while stopped and retain stale-preview protection. Runtime energy decay alone does not change configuration revisions or invalidate previews.

Migration 2 adds food/profile/energy fields, versioned settings and indexed decision records after the existing migration. Migration 1 is not replayed or rewritten. Existing data is preserved; upgraded worlds start with energy disabled and no food-source flags.

Additional `/config` commands:

| Command | Input/result |
| --- | --- |
| `settings:save` | Complete `{ energy, activity, prompts, diagnostics }`; stopped only; returns saved value/version. |
| `prompt:preview` | `{ agentId }`; returns local context, fixed constraints and provider-body preview. |
| `diagnostics:list` | Optional agentId, roomId, action, outcome, ISO from/to, sequence before, limit 1–100 (default 50); summary page. |
| `diagnostics:get` | `{ id }`; one record with saved details. |
| `diagnostics:export` | Same filters/pagination; includes saved details. |
| `diagnostics:usage` | `{}`; used/reserved/limit bytes and manual retention policy. |
| `diagnostics:clear` | `{ confirm: true }`; stopped and idle only; deletes all diagnostic rows. |

`world:state` includes shared settings/version and current agent energy. `energy:state` publishes current values separately, without invalidating configuration previews; `diagnostics:changed` refreshes the visible latest summary page.

## FLAME-147 observable activity and personal memory

Automatic room events and emotes start enabled. **Shared behaviour and energy** exposes `activity.roomEventsEnabled` and `activity.emotesEnabled`. Stop before saving. Disabling room events suppresses new departure/arrival records, not movement or speech observations. An applied move to a different room writes departure before changing membership, then arrival afterward. Origin residents see departure, destination residents see arrival, and the mover sees both. Invalid, stale, cancelled and same-room moves produce no movement events. Operator configuration edits/imports do not fabricate movement events.

`emote` has exactly `{ type: 'emote', message }`, with 1–240 characters after trimming. The editable emote prompt calls for short externally observable behaviour, excluding thoughts, dialogue and unsupported capabilities. The server enforces the text limit and action shape; arbitrary prose is not a semantic classifier. Even misleading prose cannot mutate location, energy, items or capabilities. Emotes are one turn, persist as activity and enter local observers' memories. When enabled, the provider schema excludes `wait`, and the authoritative world rejects it. When disabled, the provider schema excludes `emote`, the world rejects it, and `wait` remains silent.

Each agent has one persistent FIFO of observed records, counted together across all rooms and types. The existing `contextMessageLimit` field now controls this memory (1–50; new-agent UI default 30). Existing values are preserved. Every resident, including disabled residents, observes commits while present; observation does not wait for its next turn. Memory retains record ID, actor ID/name, type, original room ID, content and timestamp. It contains no private profiles, diagnostic copies, intentions or remote occupancy. Both previews and actual requests use this buffer with current local state, without adding room history.

Reducing an agent's limit by editing or importing immediately evicts older observations; increasing it does not restore evicted items. Clearing a room's archive removes references to that room's records from all personal memories in the same transaction. Clearing all history empties all memories. Deleting an agent removes only its buffer while preserving archived contributions and other observers' memories. Diagnostic copies remain until separately cleared.

Migration 3 marks existing archive messages as speech, creates empty observation buffers and adds activity settings plus editable observation/emote guidance. It never backfills observations or historical moves. Custom prompt text remains unchanged; the previous stock action-selection text is updated to explain emote/wait availability. Version-3 configuration requires the complete new settings. Version-2 files receive the new defaults when absent; version-1 imports preserve existing shared settings. Configuration files carry limits and behaviour settings, not runtime memories. Restart preserves memories and starts stopped.
