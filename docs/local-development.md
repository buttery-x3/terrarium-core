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
4. Create an agent with a name, instructions, current room, model and personal memory limit of 1–50 observations. The form initially suggests 30 observations. Leave timing overrides blank to inherit shared reflection, speech and emote timing. Enable the agent when ready. Saving configuration never automatically starts the run.
5. Choose **Start**. Agents reflect privately and may request a later speech or emote opportunity. Each decision can also move, eat or remain inactive. `wait` is always silent; an eligible speech or emote opportunity does not require an outward action. The server validates and applies one immediate action. Speech and italic activity show actor identity and timestamps. Eating requires enabled energy and a food-source current room.
6. **Pause** stops new operations and finishes active work. **Resume** shifts pending deadlines by the paused duration. **Stop** cancels active work and discards pending requests and late results. Disable/edit an agent to invalidate its old operation.

Sign-in uses an ephemeral loopback callback and a ten-minute timeout. If opened in the wrong browser, restart the server to cancel the attempt, then begin from the intended browser. Credentials live under `%LOCALAPPDATA%/TerrariumCore/credentials`, encrypted with an AES key protected by Windows DPAPI for the current user. Directory access is restricted to that user and SYSTEM. Terrarium does not read another application's credentials or accept API keys. ChatGPT plan-usage tokens authorize Responses requests. See [authentication provenance](authentication-provenance.md).

The scheduler permits four concurrent requests and one active operation per agent. Coincident opportunities combine into one request. Attempts time out after 60 seconds, retrying at most twice with 1/2-second backoff. Exhausted failures remain visible; later opportunities continue on their own schedules. State-read failures pause with a recovery message. Restart starts stopped without catching up missed operations. Context uses personal observations across rooms, never the room archive; the UI's room selection does not affect agent knowledge.

## Delete an agent

In **Agents**, choose **Delete [agent name]** beside its **Edit** button. The confirmation names the agent and explains that its settings will be permanently removed while existing messages are kept. Choose **Permanently delete agent** to proceed or **Cancel deletion** to keep it.

Deletion works while stopped, running or paused. It cancels the selected agent's active turn, discards late replies and removes its scheduled activity without stopping other agents. Saved conversation messages keep their original speaker names and remain part of room history. The agent list refreshes and any open edit form for the removed agent resets. Other rooms, agents and settings remain unchanged. A disconnected browser or changed agent invalidates its pending confirmation.

Invalid IDs, already-deleted agents and failed writes return errors. Deletion is blocked while a configuration import is in progress. Future exports exclude deleted agents; explicitly importing an older configuration containing their IDs can create them again. No migration or extra dependency is required.

## Export and import configuration

Use **Export configuration** in **Configuration files** to download `terrarium-config.json`. The readable UTF-8 file contains `format: "terrarium-config"`, `version: 4`, `rooms`, `agents`, and `settings`. It exports a consistent snapshot of stable IDs, personality `instructions`, motivations, operator intention, model, shared timing and optional agent timing overrides in milliseconds, retained legacy intervals, memory limits, enabled flags, room assignments, food-source flags, energy policy, activity toggles, shared prompts and diagnostic policy. Personal observations, generated private reactions/intentions, subscriptions, pending requests, conversation history, credentials, current energy, diagnostic records, run state and internal revisions are excluded.

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

Agent operations use Responses `text.format` with `type: "json_schema"` and `strict: true` through the existing ChatGPT sign-in token. Action opportunities wrap one `action` and a nullable diagnostic `intention`, for example `{"action":{"type":"eat"},"intention":null}`. Reflection opportunities additionally return private state, a delayed speech request, an emote request and optional engagement. The server derives the available action schema from the current opportunities: `wait`, `move` and `eat` remain available, while speech and emotes require eligibility. Every object rejects extra fields. Speech requires non-whitespace content and an 8,000-character maximum. Local validation and world checks still run before applying the action; a valid shape alone cannot establish that a destination exists or an operation is current.

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
| `agents:save`    | `{ id?, name, instructions, motivations?, intention?, roomId, provider: 'chatgpt', model, enabled, minIntervalMs, maxIntervalMs, contextMessageLimit, timingOverrides? }`; returns saved configuration and revision. |
| `agents:delete`  | `{ id }`; deletes one agent, cancels its active turn and preserves messages; returns `{ id }` and publishes updated world/run state. Blocked during configuration import. |
| `config:export`  | `{}`; returns the versioned configuration file object. |
| `config:preview` | Configuration file object; validates references and returns `{ token, rooms, agents, defaults, settingsChanged }`, each entity entry containing `{ id, name, operation: 'add' \| 'update' }`. |
| `config:import`  | `{ configuration, previewToken }`; requires a stopped run and a current preview; atomically merges configuration and returns the applied preview. |
| `run:control`    | `'start'`, `'pause'`, `'stop'`; returns run state.                                                                                                                       |
| `auth:login`     | `{}`; returns browser sign-in URL. Credentials stay on the server.                                                                                                       |
| `auth:models`    | `{}`; returns visible model slugs.                                                                                                                                       |

`world:state`, `run:state`, and `auth:state` synchronize the operator UI. Both namespaces receive `conversation:message` after persistence, carrying `{ id, roomId, agentId, speaker, createdAt, content, type, replyToId?, conversationId? }`, where type is `speak`, `emote`, `arrival` or `departure`, and `conversation:cleared` carrying `{ roomIds, deletedMessages }` after deletion commits. Reply and exchange identifiers are server-validated speech metadata. Humans use agent ID `config-ui` and speaker `Human`. `/terrain` also receives `rooms:list` and supports `history:get` to restore its latest room activity on reconnect. Private reflection state is available only on `/config` and in that agent's own model context.

History pages contain up to 100 messages ordered oldest to newest by saved timestamp and ID. Initially select the latest page; `before` retrieves older pages; `after` remains available for forward retrieval. The client merges live delivery and history by ID. On reconnect, it discards local history and pagination caches and fetches the latest page so offline deletion is reflected. Cleared rooms invalidate pending history requests; stale acknowledgements cannot repopulate them. New timestamps advance monotonically while messages remain saved to prevent same-millisecond inserts falling behind a cursor.

## FLAME-146 energy, profiles and prompting

Mark any room **Provides unlimited food** in its editor. Names and IDs have no special meaning; several food sources may coexist. Then, while stopped, enable energy under **Shared behaviour and energy**. Enabling/starting without a food source, or removing the last source while enabled, is rejected.

Defaults: energy is disabled; initial/maximum 100; depletion 5 points per running minute; low energy at 25 or below; meals fill to maximum. Without meals, a full agent becomes low after 15 running minutes and reaches zero after 20. Initial energy applies to newly created agents. A maximum below an existing current value is rejected. Zero clamps at zero and does not prohibit speaking, movement, eating or waiting.

Only enabled agents drain energy while the simulation runs. Passive decay uses elapsed time and is checkpointed on scheduler ticks, action/context boundaries and lifecycle changes; retries and cadence do not add charges. Pause freezes decay immediately while allowing already-active turns and their existing bounded retries to finish. An active meal may refill energy during Pause. Stop cancels pending work and preserves energy; restart starts stopped without offline catch-up or refill. An abrupt crash preserves the last committed checkpoint, so the uncommitted fraction of a running interval is not recovered offline.

Personality remains the original `instructions` field, preserved verbatim. **Motivations and preferences** is separate text (up to 8,000 characters); **Current intention** is an optional operator-configured aim (up to 1,000). Neither is an accumulating boredom meter. An action's optional self-report of up to 240 characters remains diagnostic-only. FLAME-148 reflection separately saves the latest generated private reaction and immediate intention; this does not rewrite the authored profile or turn personal observations into private notes.

The shared prompt fields are assembled in this order: role/framing, profile interpretation, action selection, energy/food guidance, reminders, personal observations, and emotes. Reflection opportunities also append the editable reflection guidance. They are followed by resolved local data and enforced protocol constraints. Defaults support self-direction, choosing an action before speech, prioritising food when low, and true inactivity without a compulsory novelty or conversation objective. Each field has a Restore default button; saving requires Stop. Required missing/blank fields fail validation; reminders may explicitly be empty. There is no hidden replacement prompt.

Choose **Private reflection**, **Speech opportunity** or **Emote opportunity**, then **Preview saved prompt** to display the saved instructions in request order, personal memory with original metadata, configured schema and complete provider-body preview. It performs no model request, creates no diagnostic operation and mutates no world state. The snapshot includes own profile, private character state, energy/activity/timing rules, current room, locally present names/IDs and the public room directory with food flags. Remote occupancy, other agents' private profiles/state, unobserved transcripts and operator logs are excluded. Earlier room history is never supplied to a new arrival.

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
| `settings:save` | Complete `{ energy, activity, scheduling, prompts, diagnostics }`; stopped only; returns saved value/version. |
| `prompt:preview` | `{ agentId, operation?: 'reflection' \| 'speech' \| 'emote' }`; defaults to reflection; returns local context, fixed constraints and provider-body preview. |
| `reflection:list` | `{}`; returns current private character states for the operator. No corresponding terrain command. |
| `diagnostics:list` | Optional agentId, roomId, action, outcome, ISO from/to, sequence before, limit 1–100 (default 50); summary page. |
| `diagnostics:get` | `{ id }`; one record with saved details. |
| `diagnostics:export` | Same filters/pagination; includes saved details. |
| `diagnostics:usage` | `{}`; used/reserved/limit bytes and manual retention policy. |
| `diagnostics:clear` | `{ confirm: true }`; stopped and idle only; deletes all diagnostic rows. |

`world:state` includes shared settings/version and current agent energy. `energy:state` publishes current values separately, without invalidating configuration previews; `diagnostics:changed` refreshes the visible latest summary page.

## FLAME-147 observable activity and personal memory

Automatic room events and emotes start enabled. **Shared behaviour and energy** exposes `activity.roomEventsEnabled` and `activity.emotesEnabled`. Stop before saving. Disabling room events suppresses new departure/arrival records, not movement or speech observations. An applied move to a different room writes departure before changing membership, then arrival afterward. Origin residents see departure, destination residents see arrival, and the mover sees both. Invalid, stale, cancelled and same-room moves produce no movement events. Operator configuration edits/imports do not fabricate movement events.

`emote` has exactly `{ type: 'emote', message }`, with 1–240 characters after trimming. The editable emote prompt calls for short externally observable behaviour, excluding thoughts, dialogue and unsupported capabilities. The server enforces the text limit and action shape; arbitrary prose is not a semantic classifier. Even misleading prose cannot mutate location, energy, items or capabilities. Emotes persist as activity and enter local observers' memories. FLAME-148 makes emotes independently scheduled and restores silent `wait` for every opportunity. Disabling emotes removes them from the provider schema and the authoritative world rejects them.

Each agent has one persistent FIFO of observed records, counted together across all rooms and types. The existing `contextMessageLimit` field now controls this memory (1–50; new-agent UI default 30). Existing values are preserved. Every resident, including disabled residents, observes commits while present; observation does not wait for its next turn. Memory retains record ID, actor ID/name, type, original room ID, content and timestamp. It contains no private profiles, diagnostic copies, intentions or remote occupancy. Both previews and actual requests use this buffer with current local state, without adding room history.

Reducing an agent's limit by editing or importing immediately evicts older observations; increasing it does not restore evicted items. Clearing a room's archive removes references to that room's records from all personal memories in the same transaction. Clearing all history empties all memories. Deleting an agent removes only its buffer while preserving archived contributions and other observers' memories. Diagnostic copies remain until separately cleared.

Migration 3 marks existing archive messages as speech, creates empty observation buffers and adds activity settings plus editable observation/emote guidance. It never backfills observations or historical moves. Custom prompt text remains unchanged; the previous stock action-selection text is updated to explain emote/wait availability. Version-3 configuration requires the complete new settings. Version-2 files receive the new defaults when absent; version-1 imports preserve existing shared settings. Configuration files carry limits and behaviour settings, not runtime memories. Restart preserves memories and starts stopped.

## FLAME-148 stage 1: reflection and independent opportunities

**Shared behaviour and energy → Reflection and action timing** controls these defaults. The UI displays seconds; saved configuration uses milliseconds. Shared changes require Stop. Each agent can override any numeric field independently; clearing its override restores inheritance. The old `minIntervalMs` and `maxIntervalMs` remain in files for compatibility, but no longer drive decisions.

| Setting | Default |
| --- | --- |
| Reflection interval | 60 seconds |
| Requested speech delay | 15–150 seconds |
| Speech cooldown | 15 seconds |
| Emote opportunity interval | Randomly chosen between 120 and 300 seconds |
| Local exchange engagement | Enabled |

Starting admits an initial reflection for each enabled agent through the four-request limit. Subsequent reflections use their configured interval. A reflection saves at most the latest reaction (1,000 characters) and immediate intention (240 characters), with a timestamp. `reflection: null` means unchanged and retains the previous timestamp; null fields inside a new reflection explicitly clear those fields. Nothing is appended to the public room timeline merely because a reflection occurred. `wait` produces no public activity even when emotes are enabled. Movement and eating remain immediate choices independently of speech and emote eligibility.

A speech request stores a delay and optional reply/addressee identifiers, not prepared dialogue. The scheduler clamps the requested delay to the configured bounds and applies the speech cooldown. When due, the model receives fresh local state and observations, and the server revalidates its room, revision and target before applying output. A subsequent reflection can replace or cancel the request. A reflection may bring an emote opportunity forward within its interval bounds. An opportunity may still choose inactivity. Simultaneously due reflection, speech and emote opportunities share one model operation.

An agent may subscribe to one witnessed local exchange identified by a root speech ID and a present interlocutor. Replies carry validated `replyToId` and server-assigned `conversationId` metadata. New replies to the subscribed exchange advance one reflection opportunity, subject to the cooldown; repeated notifications coalesce. That reflection can request a delayed response using fresh context. Leaving, interlocutor departure or explicit disengagement removes the subscription. Competing replies are allowed; there is no exclusive speaking lock or global thread history.

Open **Inspect [agent]'s private state and schedules** to see current occupants, next reflection/speech/emote opportunities, last public action times and **Generated private character state**. The operator sees each agent's state; model requests include only the requesting agent's own state. This is generated character state, not provider-internal reasoning. The `/config` command `reflection:list` returns `{ agentId, reflectedAt, reaction, intention, lastSpeechAt, lastEmoteAt, engagement }` entries; `engagement` is null or `{ roomId, rootMessageId, targetAgentId }`. `reflection:changed` requests a fresh operator read. Run-state entries expose optional `nextReflectionAt`, `nextSpeechAt`, `nextEmoteAt` and `operation` alongside existing status fields.

Diagnostics distinguish reflection, speech and emote operations, requested time, admission time, due time, actual start and completion. Full details retain the admitted opportunities, exact submitted payload, parsed response, requested delay and resulting private state. Existing privacy, retention, capacity reservation, cancellation and error handling remain in force.

Migration 4 adds private state, optional timing overrides, reply/exchange identifiers and diagnostic operation/requested timestamps. Existing profiles, models, locations, energy and observed memories are preserved. Version-4 exports include shared timing, overrides and editable reflection guidance; version-1/2/3 files remain importable with disclosed timing defaults. Private state and pending runtime work are excluded from configuration files. Stop/restart preserve the latest private reaction and intention, while pending operations are discarded; restart also clears exchange subscriptions and starts stopped. Conversation clearing removes observed messages and affected subscriptions but retains generated private reactions/intentions and diagnostic copies. Deleting an agent removes its private state.

Relationship appraisals, diverse searched news and movie/TV playback are subsequent approved FLAME-148 stages. They are not implemented by the reflection branch; see the [stacked branch plan](development-plan.md#approved-flame-148-stacked-implementation).
