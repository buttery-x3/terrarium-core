# Terrarium Core development plan

## Approved FLAME-148 room, retention and reasoning follow-up

The user approved this follow-up on 22 October 2026, with parallel sub-agents for independent implementation. Integrate the features in this order, preserving a branch at each stage:

| Branch | Approved scope |
| --- | --- |
| `codex/flame-148-room-discovery` | Exact destination IDs in ordinary/reflection schemas and previews; static facility labels without remote occupants or current news/media content; readable IDs matching the current world's room names. |
| `codex/flame-148-diagnostic-retention` | Manual pause-at-size, rolling-size and rolling-time policies; default rolling-time 30 minutes; retain complete active evidence, evict completed groups, and remove diagnostic-capacity pauses in rolling modes. |
| `codex/flame-148-reasoning-controls` | Model-specific SIWC reasoning choices beside resident/news model selection, nullable Model default, persistence/import/export, actual/preview parity and supported-choice validation. |

Rolling time uses wall-clock completion age, including Pause/Stop. Rolling size permits protected active groups to exceed its target temporarily and evicts a completed oversized group whole. Genuine database failures still surface. Legacy explicit manual settings remain supported; the current world is explicitly switched to the new 30-minute policy after validation. No live inference is required for this follow-up. Use isolated data for development and functional checks, preserve a backup before current-world changes, and verify profiles, conversation histories and personal observation links survive the room-ID remap.

Extend the existing prototype in three stages: reliable foundations, one complete agent loop, and an observable web experience. Keep the existing stack and package layout. The [project scope](project-scope.md) distinguishes implemented behavior, the next release, and deferred work.

## Review and delivery

The user approved implementation of this plan on 18 October 2026 and subsequently approved the foundation, agent behavior, and ChatGPT dependency choices recorded below. All three stages are implemented on `codex/terrarium-implementation`, pending review before merging into `main`. This does not authorize unrelated refactors or scope expansion.

Follow [AGENTS.md](../AGENTS.md) and [AGENTS_COMMENTS_STYLE.md](../AGENTS_COMMENTS_STYLE.md). Keep documentation in `docs/`. No dates or owners are assigned by this plan.

## Stage 1 Reliable local foundations

Startup ordering, explicit paths, local access controls, durable validated messages, history recovery, frontend checks, and runtime-artifact cleanup are implemented. See [local development](local-development.md) for operation and [validation](implementation-validation.md) for evidence. The stage descriptions below preserve the approved requirements.

### 1A Reproducible startup and local access

**Changes**

- Complete required package builds before starting long-running development processes; persistence currently exports compiled output while root development starts tasks in parallel.
- Resolve the repository environment file and SQLite location explicitly. Preserve the existing database when moving from a working-directory-relative path; agree the location and relocation procedure first.
- Default server access to loopback and restrict permitted UI origins and socket control connections. Check direct socket handshakes as well as browser CORS behavior, without introducing user accounts.
- Plan a targeted migration from Fastify 4 to a supported release with compatible plugins, logger setup, and a supported Node baseline. Confirm exact versions and native SQLite compatibility before changing manifests.
- Remove tracked database and generated `.vite` artifacts from Git while preserving local data. Limit ignore/build/startup configuration changes to this work.

**Affected files:** root `package.json`, `turbo.json`, `.gitignore`, affected workspace manifests and `pnpm-lock.yaml`; `apps/server/src/server.ts`; `packages/persistence/src/index.ts`; existing frontend Vite configuration where connection setup requires it; tracked `apps/server/data/terrarium.db` and `apps/ui-*/.vite` artifacts; startup documentation under `docs/`.

**Acceptance:** a clean checkout starts without pre-existing `dist` output; supported launch locations use the same environment/database; existing data is preserved; the intended local UI connects; disallowed origins and control connections fail; the chosen Node/native-dependency combination builds and starts.

### 1B Validated durable messages

**Changes**

- Define runtime input and result contracts in the existing shared schema package. Validate missing/null payloads, string types, empty or oversized messages, and room existence with approved limits.
- Introduce a focused server-side message operation used by human input and, later, agent speech: validate, save successfully, broadcast the saved record, then acknowledge success.
- Use one consistent conversation event carrying room and message identity, timestamp, and speaker information. Update existing consumers together; avoid room-targeted emission without subscriptions.
- Report rejected input and storage failures to the initiating UI or turn handler. Failed writes must not generate successful acknowledgements or conversation events.

**Affected files:** `packages/shared/src/index.ts`, `packages/persistence/src/index.ts`, `apps/server/src/server.ts`, and both existing `src/App.svelte` consumers. Add focused modules/tests inside those domains only where the approved implementation needs them.

**Acceptance:** valid input produces one saved message and a matching event/acknowledgement; malformed input produces a structured error without a crash; an injected database failure produces no successful event; human and agent callers can use the same operation.

### 1C History retrieval and recovery

**Changes**

- Add room-history reads using saved message identities and an agreed stable ordering and retrieval limit.
- Define the history request/response and reconnect contract so missed live messages are recovered and history/live overlap does not duplicate messages.
- Establish the contract and automated recovery coverage now; the conversation timeline arrives in stage 3.

**Affected files:** `packages/persistence/src/index.ts`, `packages/shared/src/index.ts`, `apps/server/src/server.ts`, related focused tests, and `docs/` contract documentation.

**Acceptance:** history survives a server restart; a disconnected client recovers messages sent while absent; overlapping live and historical results yield one displayed record per message; room selection returns only the requested room's history.

**Stage gate:** prove reliable manual messaging, history recovery, startup, and local access before introducing real model activity.

## Stage 2 One complete agent loop

### 2A Persisted rooms and agents

**Changes**

- Introduce a small, ordered migration mechanism before extending tables, including an upgrade path for existing databases created by `ensureTables`.
- Make persisted rooms, agent configuration, current membership, and conversation history authoritative. Replace hardcoded runtime room configuration through an agreed initialization policy.
- Add the fields needed for names, editable instructions, provider/model configuration, enabled state, cadence, and context settings after approving their schema/defaults. Keep credentials in the existing authentication/configuration boundary.
- Provide validated server-side configuration and membership operations that socket handlers can call. Preserve message history and agree how existing `config-ui` speaker records are interpreted.

**Affected files:** `packages/persistence/src/index.ts` and migration/query files within that package; `packages/shared/src/index.ts`; `apps/server/src/server.ts` and focused world-operation modules; related tests and `docs/`.

**Acceptance:** migrations succeed on both an empty database and a copy of the existing schema/data; repeated startup does not repeat a migration or lose data; saved configuration/membership survives restart; invalid references/settings are rejected; no schema restriction fixes population size or personality categories.

### 2B Context provider integration and accepted actions

**Changes**

- Obtain the existing tested authentication integration referenced in the excerpt and its invocation contract. It is not present in the reviewed repository; do not replace it with an invented authentication flow.
- Reuse `LmProvider` for the first real provider path. Keep transport/authentication in `packages/lm-providers` and terrarium behavior in the server; defer the other mock adapters until separately selected.
- Assemble agent instructions, permitted history, and speaker identities in one server-side context function. Apply approved observation and history-budget rules independently of UI filtering.
- Implement the proposed turn pipeline: read current state/context, request a proposal, validate the action, verify it is still applicable, apply it, persist it, and notify the UI.
- Confirm a small `speak`/`move`/`wait` contract. Speech uses the shared message path; movement validates destinations and updates durable membership; waiting produces no invented dialogue. Keep provider/configuration/parse errors separate from conversational output.

**Affected files:** `packages/lm-providers/src/types.ts` and the selected adapter; `packages/shared/src/index.ts`; server context/action/turn code; persistence queries needed for accepted actions; focused tests and `docs/`.

**Acceptance:** a fake provider exercises all three approved actions; malformed actions and unknown destinations leave the world unchanged; technical failures never appear as speech; context includes only permitted observations with identifiable speakers; a real call succeeds through the supplied authentication path after fake-provider coverage passes.

### 2C Controlled scheduling and failures

**Changes**

- Retain the simple in-process scheduler and non-blocking model execution. Initialize turns for enabled agents, enforce one active turn per agent, and bound total simultaneous requests.
- Catch failures, enforce timeouts, apply bounded retries/backoff, and expose understandable activity/error state. Define exhaustion and rescheduling behavior so a failed turn cannot silently strand an agent.
- Implement approved start/pause/stop semantics for queued and in-flight work, including disable, configuration changes, and room movement during a request.
- Resolve current agent membership at turn start. Revalidate completion against current agent/run state before applying a late response; never perpetuate a stale room ID by copying queued state.

**Affected files:** `apps/server/src/server.ts` and focused scheduler/turn modules; shared control/state schemas; the selected provider cancellation/timeout boundary if required; focused tests and `docs/`.

**Acceptance:** enabled agents start producing turns; slow requests do not block the scheduler; concurrency limits hold; timeout/rejection/retry exhaustion are observable; the approved lifecycle behavior holds during active calls; disabled, moved, or reconfigured agents cannot apply stale responses.

**Stage gate:** demonstrate one controllable agent completing a real turn and durable action, plus deterministic failure tests with a fake provider, before expanding the population.

## Stage 3 An observable web terrarium

### 3A Conversations and history

Extend `apps/ui-config` with the room list, conversation timeline, history loading, live updates, reconnect recovery, and clear send/error feedback. Preserve identities and ordering across live/history results. Keep `apps/ui-terrain` optional, retaining compatibility where shared events change.

**Affected files:** `apps/ui-config/src/App.svelte` and focused components/state code within that app; shared contracts and server handlers only where required by the approved interface.

**Acceptance:** the local operator can select a room, read saved and live speech, send a message, and reconnect without lost or duplicated displayed history. Storage failures are shown as failures.

### 3B Configuration and run controls

Add room and agent configuration, editable instructions/provider/model/cadence/context settings, enabled state, current membership, and start/pause/stop controls using the stage 2 operations. Show queued/running/error state with the detail needed to operate the toy. Support the approved configuration lifecycle; do not infer destructive deletion behavior.

**Affected files:** `apps/ui-config`, shared configuration/control schemas, server handlers, and `docs/` usage guidance.

**Acceptance:** saved edits survive reload/restart; invalid edits receive useful feedback; controls reflect authoritative server state; failures are understandable without server logs; the UI filter does not change agent knowledge.

### 3C Population verification

Prove the complete workflow with a small configurable population, then run sixteen or more agents through the same implementation. Exercise speech, movement, waiting, reconnects, slow/failed providers, and run controls. Use fake providers for repeated/load/failure scenarios, with a bounded real-provider smoke check after the request budget is agreed. An MBTI-based population, if selected, remains editable configuration data.

**Acceptance:** the configured request cap and one-turn-per-agent rule hold at both sizes; lifecycle changes reject stale completions; saved history and membership match accepted actions; the web interface remains usable; no fixed population or personality enumeration is required.

## Approved implementation decisions

| Decision                                                                                                                                       | Required by |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Supported Node/Fastify/plugin versions, permitted dependency changes, canonical environment/database paths, and preservation of existing data. | 1A          |
| Permitted UI origins/control connections, including proxy and optional terrain behavior.                                                       | 1A          |
| Message limits, speaker identity for human input, event/acknowledgement shape, history ordering/limits, and reconnect overlap behavior.        | 1B and 1C   |
| Room/agent fields and defaults, initial-room/population policy, existing-row migration, and allowed configuration/deletion operations.         | 2A          |
| Location and contract of the already tested authentication integration, first provider/model, and real-call budget.                            | 2B          |
| Action schema and observation policy, including access to history before arrival/after departure and context-size limits.                      | 2B          |
| Global concurrency, timeout/retry/backoff bounds, and exact queue/in-flight behavior for pause, stop, disable, edits, and moves.               | 2C          |

The user resolved these decisions before the affected work:

- Node 24, Fastify 5.12.7, compatible `@fastify/cors` 11.3.1; root `.env`; canonical root `data/terrarium.db`; preserve the legacy database through a SQLite backup before migration.
- Loopback server; only localhost/127.0.0.1 UI origins on ports 4173 and 4174. Socket handshakes validate host and origin.
- Messages of 1–8,000 characters after trimming; human speaker `Human`; one `conversation:message` event after commit; result acknowledgements; history pages of 100 ordered by timestamp and ID and merged by ID on reconnect.
- Five initial rooms, no automatic agents. Initially create/edit rooms and create/edit/disable agents; agent deletion was subsequently approved in the follow-up below. Legacy agents remain disabled until configured.
- ChatGPT authentication from Flamehorn Desktop and protected storage from social-summarizer-extension. Explicitly approved dependencies: `jose` 6.2.12 and `@primno/dpapi` 2.0.1. Default model `gpt-6-luna`; one real call used for the smoke check.
- Actions `speak`, `move`, `wait`; latest 1–50 messages from the current room, including before arrival. No departed-room history enters subsequent turns.
- Four concurrent calls, one turn per agent, 60-second attempts, two retries with 1/2-second backoff. Pause finishes active turns; stop, disable, edits, and movement invalidate stale results. Exhausted failures remain visible and schedule another turn after the configured cadence.

## Approved follow-up: JSON configuration files

On 18 October 2026, the user approved exporting all room/agent settings to one readable, versioned JSON file and importing through a validation preview. Matching IDs update existing entries; new IDs create entries; omitted entries remain. Imports apply in one transaction while the run is stopped, preserve enabled flags, and never start agents automatically. History, credentials and runtime state are excluded.

The implementation extends the existing config UI, shared schemas, socket commands and persistence operations without new dependencies or migrations. Preview tokens detect changes to the file or saved configuration before apply. Tests cover round trips, invalid files, duplicate IDs, missing room references, stale previews, rollback and stopped-run enforcement. Browser validation exercises file selection, preview, apply, download, re-import and reload in a separate test world. Changes remain on the review branch.

## Approved follow-up: conversation clearing

On 18 October 2026, the user approved a **Clear conversation** UI with current-room/all-room scope, confirmation before permanent deletion, and a stopped-run requirement. Clearing removes human and agent messages from storage and future agent context while retaining rooms, agents and all their settings. Both views reset affected messages, pending history responses are invalidated, and reconnect refreshes saved history to reflect clears missed while offline.

Implementation extends the existing shared contract, persistence world, server commands and both frontends; no dependencies, schema migration or build configuration changes are needed. Verify scope isolation, durable deletion, rollback, preserved settings, stopped-run enforcement, concurrent commands, late agent output, confirmation/cancel behavior and stale/reconnecting browser history. Push to the existing review branch without merging main.

## Approved follow-up: delete agents

On 18 October 2026, the user approved a **Delete [agent name]** button beside each **Edit** button. A confirmation names the agent before permanently removing its settings. Deletion cancels that agent's active turn and discards late replies while preserving existing conversation messages and speaker names. The list refreshes and any edit form for the deleted agent resets, including in other connected browsers. Other agents and the current run state remain unchanged; Stop is not required.

Extend the existing config UI, shared command schema, server handler and persistence world. Reuse scheduler invalidation, block deletion during configuration import, and validate missing IDs and failed writes. Verify durable deletion, preserved history/configuration, running/paused/stopped behavior, late responses, confirmation/cancel, form cleanup and reload. No dependencies or migrations are needed. Push to the existing review PR before merging main.

## Approved follow-up: Markdown conversation export

On 18 October 2026, the user approved an **Export conversations** button under **Conversations**. Download one Markdown file with a separate heading for each room and every saved message oldest first, including older pages and deleted agents' speech. Include speaker names, timestamps and full message text; mark empty rooms explicitly. Export a consistent snapshot while the run continues.

Extend the existing config UI, socket commands, shared export type and persistence world without new dependencies or migrations. Verify complete ordered history, multiline text, safe heading labels, empty rooms, deleted-agent speech, concurrent writes, large socket responses and error handling. Check the actual browser download in an isolated world, then push to the existing review PR without merging main.

## Validation and review evidence

For each implementation slice, run `pnpm build` with zero errors and `pnpm dev`; confirm the server starts, frontends compile, and no runtime crash occurs. Perform one relevant manual functional check and record its result in the pull request. Persistence work must also prove migrations apply cleanly and queries compile against both fresh and upgraded databases.

Add an explicit Svelte/TypeScript check using the already installed `svelte-check`; a Vite production build alone does not establish frontend type correctness. Use the existing test tooling for focused failure-boundary tests: rejected input, failed saves with no success event, reconnect recovery, and failing model turns that do not silently stop an agent. Extend that coverage for migrations, invalid/stale actions, concurrency, and run controls as those behaviors are implemented. Avoid real provider usage in automated tests.

Each review records the affected files, observable behavior, validation results, and unresolved limitations. Keep generated outputs and runtime data out of implementation commits. Update scope/usage/contract documentation in `docs/` as each stage becomes real.

## Planning baseline validation

Checks on 18 October 2026 used Node 24.15.0 and pnpm 10.26.2. They describe the existing prototype and do not establish that the planned agent behavior is implemented.

| Check                                  | Result                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                           | All six packages built successfully with zero errors.                                                                                                                 |
| `pnpm dev`                             | Server and both frontends started after rebuilding the locally installed SQLite native dependency for the active Node version; package watchers reported zero errors. |
| Manual endpoint and socket smoke check | `/health` returned HTTP 200 and `status: ok`; both frontend pages and Svelte modules returned HTTP 200; both socket namespaces returned the five existing rooms.      |
| Documentation                          | Both files passed formatting checks; all eleven relative links resolved.                                                                                              |

The first development attempt failed because the installed `better-sqlite3` binary targeted a different Node ABI. Rebuilding that existing dependency in `packages/persistence` repaired the local installation without changing source, manifests, or the lockfile. A successful development run after a build does not prove the fresh-checkout startup race is resolved. The smoke check did not exercise a real model call or browser interaction.

## Approved FLAME-146 implementation

The user approved the bounded plan and defaults on 18 October 2026 after the local and remote main commits were verified as `b1eea79`. Work is on `codex/flame-146` and extends the existing shared contracts, ordered migrations/world operations, scheduler/turn pipeline, ChatGPT payload boundary, config UI and their existing tests. No dependencies, build configuration, authentication redesign or terrain expansion are included.

Approved decisions: energy disabled initially; initial/maximum 100, depletion 5 per running minute, low at 25, meals filling to maximum; zero does not restrict movement, speech or waiting; freeze while paused/stopped/disabled/offline and preserve energy across Stop/restart. The approved FLAME-148 follow-up below restricts eating to low energy below maximum in a food-source room while energy is enabled. Active Pause work may finish, including eligible meals. Initial changes affect new agents; maximum cannot be below existing energy. At least one food source is required for an enabled loop.

Profiles preserve `instructions` as personality and add separate motivations/operator intention. Optional model-declared intention is diagnostic-only and never becomes memory. Shared behavioural prompts are editable/restorable, with a request-free preview and exact actual-request capture. Shared settings edits require Stop. Diagnostic retention is manual, defaults to a 256 MiB payload budget with in-flight reservations, and pauses on insufficient capacity/logging failures. Conversation clearing retains diagnostic copies with an explicit warning; separate diagnostic clearing requires Stop and confirmation.

The implementation adds version-2 configuration while preserving version-1 imports, current runtime energy, IDs, histories, omitted records, preview validity checks and atomic rollback. See local-development.md for shipped behaviour, field limits and recovery procedures, and implementation-validation.md for validation evidence.

## Approved FLAME-148 stacked implementation

On 19 October 2026 the user approved the FLAME-148 plan, including the revised news and media designs, and requested sub-agents for suitable simultaneous work. FLAME-147 is preserved separately as prerequisite commit `9b9bd1a` on `codex/flame-147`. Feature branches build sequentially on the preceding feature because they share scheduling, contracts and ordered migrations. Independent files within a stage may be implemented simultaneously; shared files require explicit ownership.

| Branch | Scope and status |
| --- | --- |
| `codex/flame-148-reflection` | Implemented and validated as `b3501a2`: latest private reflection, independent speech/emote opportunities, inactivity, local exchange engagement, settings, previews and diagnostics. |
| `codex/flame-148-relationships` | Implemented and validated as `77369c2`: witnessed appraisals, directional capped scores, durable evidence and periodic evidence-linked summaries. |
| `codex/flame-148-news` | Implemented and validated as `b2dc359`: shared web-search-based news selection, varied topics, recent-headline deduplication, sources and local room observations. |
| `codex/flame-148-media` | Implemented as `1276006`: agent-proposed movie/TV title and description, ten-minute playback, immediate starts when idle and votes for replacements. Integrated build/check and 240 tests pass; the completed live comparison is recorded in implementation-validation.md. |

The reflection stage uses 60-second reflections, 15–150-second requested speech delays, a 15-second speech cooldown and 120–300-second emote intervals. Optional per-agent overrides inherit shared defaults when blank. True inactivity produces no outward event. Delayed speech requests retain intent/targets rather than prepared dialogue; execution rereads current context and validates location, targets and cancellation. Each agent has at most one active model operation; the global bound remains four. Coincident opportunities coalesce. Generated private state is available to its agent and the operator, never to other agents. Existing authored profiles, event-time observations, energy rules and provider credentials are preserved.

The relationships stage accepts zero to two appraisals per reflection by default, configurable up to five, from other agents' speech/authored emotes in the actual observation snapshot. Each appraisal includes a source ID, like/dislike and a nonempty reason up to 240 characters. The server resolves the author and enforces unique observer/source evidence across retries/restarts. Scores start at zero and apply +1/−1 with an immediate clamp to −10…+10; there is no hidden overflow balance. Changed relationships are summarized approximately every ten minutes in bounded batches with retained evidence/version history. Prompts include at most eight relevant own relationships. A stopped-run confirmed relationship-memory reset clears dependent state; diagnostic copies remain separately managed.

The news stage replaces the initially proposed BBC World RSS feed. One shared ChatGPT request approximately every ten minutes uses actual web search and the current/recent headlines to select a substantially different item. Editable instructions seek a mix of sport/upcoming events, science, nature, technology, entertainment, food, human-interest stories and major world events, with lighter material and variety. Publish a headline, short description, source links and relevant dates only with search evidence. Failures or repeated candidates retain the current item and expose the failure. Search results are untrusted content. The approved stopped-run room preview has renamed `room-1` from Reading Room to News Room while retaining its ID/archive and enabling the capability. No RSS/XML dependency is needed. Availability remains subject to model/account search support; failures are explicit.

The media stage adds `media-room` without replacing existing rooms. Agents propose a movie or TV title and short description; model recollections or invented details are acceptable simulation material, so no external catalogue or streaming integration is required. If nothing is playing, a valid resident proposal starts immediately without a ballot. If something is playing, replacement requires a local vote. All present residents and new arrivals receive the current title, description and remaining time alongside room context. Playback lasts ten minutes of running simulation time, freezes during Pause/Stop, preserves remaining duration across restart, then shows “Nothing is currently playing.” There is no automatic replay. Simultaneous idle starts resolve atomically; expiry cancels an unresolved replacement ballot.

Replacement ballots use enabled residents present at opening as the fixed electorate. Choices are change/keep/abstain; the author must cast a real vote. A strict majority of the original electorate must vote change before a 120-second running-time deadline. Missing/invalid/late votes never become agreement. Already-cast departing votes remain; uncast departing requests are withdrawn without shrinking the denominator; arrivals do not join. One ballot may be active per room. The five-minute replacement-proposal cooldown never blocks starting idle playback. Proposals and aggregate results are public; individual votes are operator-visible. Pause freezes deadlines; Stop/restart cancels unresolved ballots. Vote work shares the bounded scheduler independently of speech cadence. A successful ballot changes playback exactly once.

Every stage includes settings, operator inspection, bounded diagnostics, focused deterministic tests, ordered migration/import compatibility and updated documentation. Validate `pnpm build`, `pnpm check`, `pnpm test`, development startup and a relevant manual check per branch. After integration, the approved live comparison is two isolated 15-minute runs capped at 160 model requests combined, retaining models/personality profiles and reporting observed repetition, directed exchanges, room-event responses and continuity. Pending stages and live comparison must not be reported as completed before their implementation and evidence exist.

All four implementation stages and both live runs are now complete. The live pair used 110 requests and exposed amplified high-energy eating with no enhanced speech or appraisals; it does not demonstrate the intended social improvement. See [validation evidence and limitations](implementation-validation.md#flame-148-controlled-live-comparison--19-october-2026). The actual world remains stopped with News Room and Media Room enabled, preserving all authored profiles, energy, observations and archives.

## Approved FLAME-148 follow-up: eating eligibility and exchange responses

The user approved two bounded corrections after the live comparison. Eating requires enabled energy, a food-source current room, energy at or below `lowThreshold` and energy below `maximum`; the defaults remain 25 and 100. Both the offered model schema and the authoritative action guard enforce this rule. Movement remains unchanged, and saved authored prompts are preserved.

Contributions to a subscribed exchange create optional speech opportunities subject to the existing cooldown, coalescing, Pause and cancellation rules. They do not advance reflection; reflection joins only when its regular cadence is due. Future speech plans remain scheduled and respect the cooldown after actual speech. A due opportunity consumed by a request that becomes stale is cancelled without automatic replay. Operator snapshots show exchange deadlines in `nextSpeechAt`, while `nextReflectionAt` reports only the regular cadence.

Both corrections are implemented and operator help/development guidance are aligned. Build, both frontend checks, all 286 tests, isolated development startup and a manual eating/engagement check pass. See [follow-up validation](implementation-validation.md#flame-148-energy-and-engagement-follow-up--19-october-2026). The earlier live comparison predates these corrections; improved social behaviour has not yet been measured in another live run.

## Approved FLAME-148 follow-up: reasoning strength

The approved reasoning controls are implemented on `codex/flame-148-reasoning-controls` in an isolated worktree. Residents and the shared news job each have a nullable Model default setting and dynamic choices from the current SIWC catalog. Resident choices apply to reflection, speech/emotes, legacy turns, relationship summaries and media votes; news keeps its own choice. Save/import/request validation and exact payload previews use the same supported efforts. Unsupported saved choices remain visible, and a user changing models keeps a supported unsaved choice or receives a reset notice.

This branch adds ordered migration/configuration version 9, older-file compatibility, sanitized catalog discovery and focused persistence/provider/socket/UI coverage. It preserves authored prompts, existing authentication and the legacy string model-list endpoint. It introduces no dependencies or paid inference during development. Integrated startup and browser validation follow the stacked branch integration; final evidence belongs in implementation-validation.md.
