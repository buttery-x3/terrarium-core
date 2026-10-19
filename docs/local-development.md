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
5. Choose **Start**. Agents reflect privately and may request a later speech or emote opportunity. Each decision can also move, eat when eligible or remain inactive. `wait` is always silent; an eligible speech or emote opportunity does not require an outward action. The server validates and applies one immediate action. Speech and italic activity show actor identity and timestamps. Eating requires enabled energy, a food-source current room, energy at or below the configured low threshold and energy below maximum.
6. **Pause** stops new operations and finishes active work. **Resume** shifts pending deadlines by the paused duration. **Stop** cancels active work and discards pending requests and late results. Disable/edit an agent to invalidate its old operation.

Sign-in uses an ephemeral loopback callback and a ten-minute timeout. If opened in the wrong browser, restart the server to cancel the attempt, then begin from the intended browser. Credentials live under `%LOCALAPPDATA%/TerrariumCore/credentials`, encrypted with an AES key protected by Windows DPAPI for the current user. Directory access is restricted to that user and SYSTEM. Terrarium does not read another application's credentials or accept API keys. ChatGPT plan-usage tokens authorize Responses requests. See [authentication provenance](authentication-provenance.md).

The scheduler permits four concurrent requests and one active operation per agent. Coincident opportunities combine into one request. Normal decision and relationship-summary attempts time out after 60 seconds, retrying at most twice with 1/2-second backoff. Media votes receive one request and preserve invalid/missing outcomes; failed news checks wait for the next news interval. Exhausted failures remain visible; later opportunities continue on their own schedules. State-read failures pause with a recovery message. Restart starts stopped without catching up missed operations. Context uses personal observations across rooms, never the room archive; the UI's room selection does not affect agent knowledge.

## Delete an agent

In **Agents**, choose **Delete [agent name]** beside its **Edit** button. The confirmation names the agent and explains that its settings will be permanently removed while existing messages are kept. Choose **Permanently delete agent** to proceed or **Cancel deletion** to keep it.

Deletion works while stopped, running or paused. It cancels the selected agent's active turn, discards late replies and removes its scheduled activity without stopping other agents. Saved conversation messages keep their original speaker names and remain part of room history. The agent list refreshes and any open edit form for the removed agent resets. Other rooms, agents and settings remain unchanged. A disconnected browser or changed agent invalidates its pending confirmation.

Invalid IDs, already-deleted agents and failed writes return errors. Deletion is blocked while a configuration import is in progress. Future exports exclude deleted agents; explicitly importing an older configuration containing their IDs can create them again. No migration or extra dependency is required.

## Export and import configuration

Use **Export configuration** in **Configuration files** to download `terrarium-config.json`. The readable UTF-8 file contains `format: "terrarium-config"`, `version: 7`, `rooms`, `agents`, and `settings`. It exports a consistent snapshot of stable IDs, personality `instructions`, motivations, operator intention, model, shared timing and optional agent timing overrides in milliseconds, retained legacy intervals, memory limits, enabled flags, room assignments, food-source flags, energy policy, activity toggles, relationship appraisal/summary settings, news/media settings, shared prompts and diagnostic policy. Personal observations, generated private reactions/intentions, relationship evidence/scores/summaries, selected-news history/current display, media programmes/ballots/votes, subscriptions, pending requests, conversation history, credentials, current energy, diagnostic records, run state and internal revisions are excluded.

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

Agent operations use Responses `text.format` with `type: "json_schema"` and `strict: true` through the existing ChatGPT sign-in token. Action opportunities wrap one `action` and a nullable diagnostic `intention`, for example `{"action":{"type":"eat"},"intention":null}`. Reflection opportunities additionally return private state, a delayed speech request, an emote request and optional engagement. The server derives the available action schema from the current opportunities: `wait` and `move` remain available, eating requires enabled energy, a food-source current room, energy at or below the low threshold and below maximum, and speech/emotes require their opportunity eligibility. Every object rejects extra fields. Speech requires non-whitespace content and an 8,000-character maximum. Local validation and world checks still run before applying the action; a valid shape alone cannot establish that a destination exists or an operation is current.

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

`world:state`, `run:state`, and `auth:state` synchronize the operator UI. Both namespaces receive `conversation:message` after persistence, carrying `{ id, roomId, agentId, speaker, createdAt, content, type, replyToId?, conversationId? }`, where type is `speak`, `emote`, `arrival`, `departure`, `news` or `media`, and `conversation:cleared` carrying `{ roomIds, deletedMessages }` after deletion commits. Reply and exchange identifiers are server-validated speech metadata. Humans use agent ID `config-ui` and speaker `Human`; news/media world events use `world-news`/`world-media`. `/terrain` also receives `rooms:list` and supports `history:get` to restore its latest room activity on reconnect. Private reflection state and individual votes are available only through operator inspection and their own applicable model request, not other agents' context.

History pages contain up to 100 messages ordered oldest to newest by saved timestamp and ID. Initially select the latest page; `before` retrieves older pages; `after` remains available for forward retrieval. The client merges live delivery and history by ID. On reconnect, it discards local history and pagination caches and fetches the latest page so offline deletion is reflected. Cleared rooms invalidate pending history requests; stale acknowledgements cannot repopulate them. New timestamps advance monotonically while messages remain saved to prevent same-millisecond inserts falling behind a cursor.

## FLAME-146 energy, profiles and prompting

Mark any room **Provides unlimited food** in its editor. Names and IDs have no special meaning; several food sources may coexist. Then, while stopped, enable energy under **Shared behaviour and energy**. Enabling/starting without a food source, or removing the last source while enabled, is rejected.

Defaults: energy is disabled; initial/maximum 100; depletion 5 points per running minute; low energy at 25 or below; meals fill to maximum. Eating is eligible only with enabled energy in a food-source room, at or below the configured low threshold and below maximum. Without meals, a full agent becomes low after 15 running minutes and reaches zero after 20. Initial energy applies to newly created agents. A maximum below an existing current value is rejected. Zero clamps at zero and does not prohibit speaking, movement or waiting; eating still follows its eligibility rules.

Only enabled agents drain energy while the simulation runs. Passive decay uses elapsed time and is checkpointed on scheduler ticks, action/context boundaries and lifecycle changes; retries and cadence do not add charges. Pause freezes decay immediately while allowing already-active turns and their existing bounded retries to finish. An active meal may refill energy during Pause. Stop cancels pending work and preserves energy; restart starts stopped without offline catch-up or refill. An abrupt crash preserves the last committed checkpoint, so the uncommitted fraction of a running interval is not recovered offline.

Personality remains the original `instructions` field, preserved verbatim. **Motivations and preferences** is separate text (up to 8,000 characters); **Current intention** is an optional operator-configured aim (up to 1,000). Neither is an accumulating boredom meter. An action's optional self-report of up to 240 characters remains diagnostic-only. FLAME-148 reflection separately saves the latest generated private reaction and immediate intention; this does not rewrite the authored profile or turn personal observations into private notes.

The shared prompt fields are assembled in this order: role/framing, profile interpretation, action selection, energy/food guidance, reminders, personal observations, and emotes. Reflection opportunities also append the editable reflection guidance. They are followed by resolved local data and enforced protocol constraints. Defaults support self-direction, choosing an action before speech, prioritising food when low, and true inactivity without a compulsory novelty or conversation objective. Each field has a Restore default button; saving requires Stop. Required missing/blank fields fail validation; reminders may explicitly be empty. There is no hidden replacement prompt.

Choose **Private reflection**, **Speech opportunity** or **Emote opportunity**, then **Preview saved prompt** to display the saved instructions in request order, personal memory with original metadata, configured schema and complete provider-body preview. It performs no model request, creates no diagnostic operation and mutates no world state. The snapshot includes own profile, private character state, energy/activity/timing rules, current room, locally present names/IDs and the public room directory with food flags. Remote occupancy, other agents' private profiles/state, unobserved transcripts and operator logs are excluded. Earlier room history is never supplied to a new arrival.

The provider schema accepts `{"action":{"type":"eat"},"intention":null}` only when eating is eligible. Provider requests require the nullable `intention` field; local validation continues to accept older action-only responses. The server authorises exactly one action, rechecks enabled energy, current food-source location, the low threshold and energy below maximum when applying eating, and records rejected attempts. These enforced rules do not rewrite saved authored prompts. Saying “I ate” is only speech. Movement eligibility is unchanged; a move to the same room is recorded as an applied no-op. Eating fills current energy transactionally and generates activity, not fabricated speech.

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
| `settings:save` | Complete `{ energy, activity, scheduling, relationships, news, media, prompts, diagnostics }`; stopped only; returns saved value/version. |
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

Starting admits an initial reflection for each enabled agent through the four-request limit. Subsequent reflections use their configured interval. A reflection saves at most the latest reaction (1,000 characters) and immediate intention (240 characters), with a timestamp. `reflection: null` means unchanged and retains the previous timestamp; null fields inside a new reflection explicitly clear those fields. Nothing is appended to the public room timeline merely because a reflection occurred. `wait` produces no public activity even when emotes are enabled. Movement remains available independently of speech and emote eligibility; eating has the same independence but requires its energy and food-source eligibility.

A speech request stores a delay and optional reply/addressee identifiers, not prepared dialogue. The scheduler clamps the requested delay to the configured bounds and applies the speech cooldown. When due, the model receives fresh local state and observations, and the server revalidates its room, revision and target before applying output. A subsequent reflection can replace or cancel the request. A reflection may bring an emote opportunity forward within its interval bounds. An opportunity may still choose inactivity. Simultaneously due reflection, speech and emote opportunities share one model operation.

An agent may subscribe to one witnessed local exchange identified by a root speech ID and a present interlocutor. Replies carry validated `replyToId` and server-assigned `conversationId` metadata. New replies to the subscribed exchange create one speech opportunity subject to the speech cooldown; repeated notifications coalesce. The opportunity uses fresh local context and may remain silent. Reflection stays on its regular cadence and joins the operation only when independently due. Existing Pause, cancellation and future speech-plan handling still apply. Leaving, interlocutor departure or explicit disengagement removes the subscription. Competing replies are allowed; there is no exclusive speaking lock or global thread history.

Open **Inspect [agent]'s private state and schedules** to see current occupants, next reflection/speech/emote opportunities, last public action times and **Generated private character state**. The operator sees each agent's state; model requests include only the requesting agent's own state. This is generated character state, not provider-internal reasoning. The `/config` command `reflection:list` returns `{ agentId, reflectedAt, reaction, intention, lastSpeechAt, lastEmoteAt, engagement }` entries; `engagement` is null or `{ roomId, rootMessageId, targetAgentId }`. `reflection:changed` requests a fresh operator read. Run-state entries expose optional `nextReflectionAt`, `nextSpeechAt`, `nextEmoteAt` and `operation` alongside existing status fields. `nextReflectionAt` follows the regular reflection cadence; `nextSpeechAt` includes subscribed-exchange deadlines as well as requested speech plans.

Diagnostics distinguish reflection, speech and emote operations, requested time, admission time, due time, actual start and completion. Full details retain the admitted opportunities, exact submitted payload, parsed response, requested delay and resulting private state. Existing privacy, retention, capacity reservation, cancellation and error handling remain in force.

Migration 4 adds private state, optional timing overrides, reply/exchange identifiers and diagnostic operation/requested timestamps. Existing profiles, models, locations, energy and observed memories are preserved. Version-4 exports include shared timing, overrides and editable reflection guidance; version-1/2/3 files remain importable with disclosed timing defaults. Private state and pending runtime work are excluded from configuration files. Stop/restart preserve the latest private reaction and intention, while pending operations are discarded; restart also clears exchange subscriptions and starts stopped. Conversation clearing removes observed messages and affected subscriptions but retains generated private reactions/intentions and diagnostic copies. Deleting an agent removes its private state.

Relationship appraisals, diverse searched news and movie/TV playback are implemented in stages 2–4 below; see the [stacked branch plan](development-plan.md#approved-flame-148-stacked-implementation).

## FLAME-148 stage 2: directional relationships

Reflections may return zero to two optional appraisals by default. **Maximum appraisals per reflection** permits 0–5; zero stops new appraisals. Each appraisal identifies an observed speech or authored emote, `like`/`dislike`, and a nonempty reason of at most 240 characters. Eligibility comes from the exact observation snapshot supplied to that reflection. Self-authored items, operator messages, movement and world-generated events are excluded. The server supplies the observer and resolves the source author rather than accepting a model-selected target.

Each accepted appraisal stores its reason and a complete source snapshot, including original actor, room, timestamp, content and identity. An observer can appraise a source only once; retries and restart do not apply a duplicate score change. A directional observer→target score starts at zero, changes by +1/−1, and clamps after every accepted update to −10…+10. A dislike at +10 immediately reduces the score to +9; no overflow balance accumulates. Scores do not force actions or make another agent's reciprocal impression public.

Changed relationships are eligible for summarization approximately every ten minutes by default. **Relationship summary interval** is editable in seconds; **Maximum new appraisals per summary batch** defaults to 20 and permits 1–50. Summary requests use the observer's profile, the previous summary and the next bounded evidence batch. They share the four-request global limit and single-operation-per-agent rule. Each version retains its timestamp, covered appraisal sequence, previous-summary link and validated supporting appraisal IDs. Invalid/stale responses do not overwrite a saved summary. Summary prompts are editable under **Relationship summary guidance**; appraisal guidance is separately editable.

Reflection/action context includes at most eight of the observer's own relationships, prioritizing present residents and people referenced in current observations. Context contains directional scores and the latest concise summaries. It excludes other agents' opinions, their private state and unrelated operator records. An impression is generated character interpretation, not an objective judgment about the target.

The **Relationships and appraisal evidence** panel filters by observer and target ID, including deleted IDs, and shows 25 directional relationships per page. Inspect a pair to page through 25 appraisals or 10 summary versions. Expand a source to see the saved content and provenance. Expand a summary's supporting evidence to retrieve those exact appraisal records even when they are outside the current ledger page. **Preview summary request** displays the current assembled prompt, batch and provider payload without a model call, or reports that no changed evidence needs summarizing. Regular reflection previews also expose the requesting agent's relevant relationships.

Conversation clearing retains appraisals, their copied source evidence, scores and summaries; the confirmation discloses this. **Reset relationship memory** instead requires Stop, finished active/cancelled work and explicit confirmation. It atomically clears all appraisals, scores and summary versions together with generated private reactions, intentions and exchange subscriptions. It preserves conversations, authored profiles, actual last speech/emote timestamps and diagnostics. **Clear diagnostics** remains a separate action, and downloaded copies remain independent. Deleting an agent preserves historical relationship evidence for operator inspection.

Additional operator-only `/config` commands:

| Command | Input/result |
| --- | --- |
| `relationships:list` | `{ observerId?, targetAgentId?, before?, limit? }`; paged directional scores/latest summaries. |
| `relationships:appraisals` | Same filters; paged complete appraisal records. |
| `relationships:appraisal` | `{ id }`; exact saved appraisal record or null if absent. |
| `relationships:summaries` | `{ observerId, targetAgentId, beforeVersion?, limit? }`; paged summary versions with supporting IDs. |
| `relationships:preview` | `{ observerId, targetAgentId }`; current summary request preview or null when no changed evidence remains. |
| `relationships:reset` | `{ confirm: true }`; stopped and idle only; returns deleted appraisal/relationship/summary counts. |

`relationships:changed` refreshes latest operator pages after appraisal/summary changes or reset; reset also refreshes private state. Older pages remain available until the operator returns to the latest page. Diagnostic operations identify relationship-summary requests and preserve their exact evidence, provider payload, output and application result.

Migration 5 creates the unique appraisal ledger, directional scores and summary versions. Existing private state, authored configuration, observations, energy and archives are preserved. Version-5 exports include relationship settings and editable appraisal/summary prompts; versions 1–4 remain importable with disclosed defaults. Runtime relationship data is never imported or exported as configuration. This stage adds no dependency or authentication change.

## FLAME-148 stage 3: varied, sourced news

**Shared behaviour and energy → News selection** assigns one room a current news display and one shared news-selection job. News starts disabled after migration. Defaults are room `room-1`, a ten-minute interval, model `gpt-6-luna`, and the twelve most recently selected headlines supplied for variety. Editable topics start with sport/upcoming events, science, nature, technology, entertainment, food, human interest and major world news. Enter 1–12 topics, one per line, with at most 160 characters each; the recent-headline window permits 1–30. **News selection guidance** is editable alongside other prompts. Shared changes require Stop.

To apply the approved room setup, choose **Preview News Room setup** while stopped. It reads saved configuration, changes only room-1's name/description and enables the news capability there, then opens the existing configuration preview. Review **News Room setup** under **Configuration files** and choose **Apply import** to save. IDs, archives, other rooms and agent profiles are retained. This uses saved configuration; save other form edits first. Migration itself neither renames rooms nor enables model calls. Any existing room can instead be assigned through the news settings.

The shared request uses the existing ChatGPT provider with web search enabled, the current display and recent headlines. It asks for one sufficiently different sourced story, including lighter material and upcoming events. The provider must complete an actual search; unsupported account/model search capability fails visibly. A selected item includes a headline up to 240 characters, description up to 1,600, one configured category, publication time when known, and 1–5 source URLs. The server validates each attribution against URLs returned by search and deduplicates normalized headlines and source articles across restart. Search text and recent headlines are treated as untrusted data. Topic diversity and factual wording are guided by the prompt; URL validation does not independently verify every prose claim.

An empty successful selection leaves the current display unchanged and records a completed check. Retrieval errors, invalid sources and repeated candidates also retain the display, with an explicit failure. **Last successful check** can therefore be newer than the displayed item's **Retrieved** timestamp. Selecting a new item atomically stores its metadata and publishes one typed `news` event in the assigned room. Present residents observe it; later arrivals receive the current display in local context without earlier room conversation. News is world activity and cannot be used as interpersonal appraisal evidence.

The news job shares the four-request limit with resident operations and relationship summaries. Start checks immediately when no current item exists; otherwise it waits the configured interval. Pause finishes active work and freezes pending deadlines; Stop cancels outstanding work. Restart starts stopped and retains selected headlines, deduplication and status without replaying missed intervals. News diagnostics capture the exact search-enabled payload, returned sources, output and acceptance/failure. A separate operator preview makes no model or search request.

**News display** shows the assigned room, current headline/description/category, source links, publication/retrieval times, last attempt/check, failure and next selection time. **Selected news history** pages through twenty retained items. **Preview news request** shows the saved context and exact provider payload, including search-tool settings. Conversation clearing removes its room events and observations but preserves selected-news history and the current display; the confirmation discloses this. Configuration files exclude runtime news.

| `/config` command | Input/result |
| --- | --- |
| `news:state` | `{}`; `{ current, lastAttemptAt, lastSuccessAt, error }`. |
| `news:history` | `{ before?, limit? }`; `{ items, hasMore, next? }`, default 20 and maximum 100 records. |
| `news:preview` | `{}`; saved news context, constraints and exact search-enabled provider payload without a request. |

`news:changed` refreshes operator state. `run:state.nextNewsAt` exposes the next deadline and `newsError` exposes scheduling failures. There is no manual-fetch action. Migration 6 adds persistent news history, unique source identities and status. Configuration version 6 includes news settings and prompt while accepting older versions with news disabled by default. No RSS feed, XML library, separate credential or subscription is added.

## FLAME-148 stage 4: movies, TV and replacement votes

**Shared behaviour and energy → Movies and TV** enables one room for agent-suggested programmes. Defaults are disabled, room `media-room`, ten minutes of running-time playback, a two-minute replacement-vote deadline and a five-minute replacement-proposal cooldown. Timing fields are editable in seconds, stored in milliseconds, and require Stop to save. **Movie and TV participation guidance** and **Media vote guidance** are separate editable prompts.

Choose **Preview Media Room setup** while stopped to add `media-room` if absent and enable the capability there. It uses the existing configuration preview/import; review **Media Room setup**, then choose **Apply import**. An existing `media-room` keeps its authored name and description; other rooms, profiles and archives are retained. The preview uses saved settings. Migration does not create a room or enable the capability automatically.

An agent in the assigned room may choose `propose-media` with a title up to 240 characters and a nonempty description up to 1,000 characters. These are movie/TV recollections supplied by the character; inaccuracies and invented details are accepted simulation material. There is no fixed catalogue, streaming integration or factual lookup. Every present resident and later arrival receives the current title, description and remaining time in local room context. This runtime display does not overwrite the authored room description or supply earlier room conversation.

When idle, a valid proposal starts immediately without a vote, even during a replacement-proposal cooldown. Concurrent starts are resolved transactionally. When a programme is already playing, a proposal opens one replacement ballot; a second active ballot is rejected. Programme expiry clears the display and emits **Nothing is currently playing.** There is no automatic replay. An unresolved ballot is cancelled if its original programme expires.

The electorate is the enabled residents present when the ballot opens, including the proposer. Each receives a separate bounded model request to choose `change`, `keep` or `abstain`, independently of public speech timing. The proposer must cast a real vote. Passing requires `floor(original electorate / 2) + 1` explicit change votes. No response, invalid output or provider failure becomes agreement. Departures keep already-cast votes but withdraw uncast requests without reducing the denominator; arrivals do not join an existing ballot. Pending requests become missing when the deadline passes. A passed ballot replaces the programme once with a fresh playback duration; failed/cancelled ballots do not apply a replacement.

Playback, ballot deadlines and proposal cooldowns use elapsed running simulation time. Pause freezes them and lets active work settle. Stop cancels unresolved ballots and outstanding requests while preserving the remaining programme duration. Restart starts stopped, preserves playback remainder and cancels unresolved ballots without replay or offline catch-up. Voting uses the existing four-request limit and one active operation per resident. News, summaries, reflection and votes share admission capacity.

**Media room playback and votes** displays authoritative remaining time supplied by the server once per second, with no client-side clock drift during Pause/Stop. It shows current or idle playback, active/last ballot, original electorate, required majority and honest aggregate status counts. **Operator-only individual votes** shows saved choices, pending/invalid/missing/withdrawn/cancelled statuses and request errors. The room sees proposals and aggregate results only. **Replacement vote history** pages through twenty ballots; inspect one for its original programme and individual evidence. Pending voters have a request-free preview of the actual vote context and provider payload. There are no operator vote or manual playback actions.

Typed `media` announcements record starts, proposals, aggregate outcomes and expiry as local world activity. Present residents observe the events; new arrivals see only the current display and public open proposal. Individual votes never become room events or another resident's model context. Media world events are excluded from interpersonal appraisal evidence. Diagnostics retain exact vote requests, responses and application/failure results; filters include `propose-media` and `media-vote`.

| `/config` command | Input/result |
| --- | --- |
| `media:state` | `{}`; current programme/remaining time/cooldown plus active and last ballot with operator vote records. |
| `media:ballots` | `{ before?, limit? }`; `{ ballots, hasMore, next? }`, bounded summaries with aggregate counts. |
| `media:ballot` | `{ id }`; complete ballot, original programme and individual vote records, or null if absent. |
| `media:preview` | `{ agentId, ballotId }`; pending vote request preview or null when no valid vote remains. |

The operator `media:state` event refreshes timers without repeatedly fetching ballot history. `media:changed` refreshes transition/history views. Conversation clearing removes public events and observations but retains current programmes, ballot/vote records and separate diagnostics, as disclosed in its confirmation. Migration 7 adds media runtime state and ballot/vote records; version-7 configuration includes capability settings and prompts, accepts versions 1–6 with disabled media defaults, and excludes runtime programmes or votes. No dependency or authentication change is added.
