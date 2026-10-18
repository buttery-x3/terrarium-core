# Terrarium Core development plan

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
- Five initial rooms, no automatic agents. Create/edit rooms and create/edit/disable agents; no deletion. Legacy agents remain disabled until configured.
- ChatGPT authentication from Flamehorn Desktop and protected storage from social-summarizer-extension. Explicitly approved dependencies: `jose` 6.2.12 and `@primno/dpapi` 2.0.1. Default model `gpt-6-luna`; one real call used for the smoke check.
- Actions `speak`, `move`, `wait`; latest 1–50 messages from the current room, including before arrival. No departed-room history enters subsequent turns.
- Four concurrent calls, one turn per agent, 60-second attempts, two retries with 1/2-second backoff. Pause finishes active turns; stop, disable, edits, and movement invalidate stale results. Exhausted failures remain visible and schedule another turn after the configured cadence.

## Approved follow-up: JSON configuration files

On 18 October 2026, the user approved exporting all room/agent settings to one readable, versioned JSON file and importing through a validation preview. Matching IDs update existing entries; new IDs create entries; omitted entries remain. Imports apply in one transaction while the run is stopped, preserve enabled flags, and never start agents automatically. History, credentials and runtime state are excluded.

The implementation extends the existing config UI, shared schemas, socket commands and persistence operations without new dependencies or migrations. Preview tokens detect changes to the file or saved configuration before apply. Tests cover round trips, invalid files, duplicate IDs, missing room references, stale previews, rollback and stopped-run enforcement. Browser validation exercises file selection, preview, apply, download, re-import and reload in a separate test world. Changes remain on the review branch.

## Approved follow-up: conversation clearing

On 18 October 2026, the user approved a **Clear conversation** UI with current-room/all-room scope, confirmation before permanent deletion, and a stopped-run requirement. Clearing removes human and agent messages from storage and future agent context while retaining rooms, agents and all their settings. Both views reset affected messages, pending history responses are invalidated, and reconnect refreshes saved history to reflect clears missed while offline.

Implementation extends the existing shared contract, persistence world, server commands and both frontends; no dependencies, schema migration or build configuration changes are needed. Verify scope isolation, durable deletion, rollback, preserved settings, stopped-run enforcement, concurrent commands, late agent output, confirmation/cancel behavior and stale/reconnecting browser history. Push to the existing review branch without merging main.

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
