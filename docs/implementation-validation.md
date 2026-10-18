# Implementation validation

Validated on Windows with Node 24.15.0 and pnpm 10.26.2, 18 October 2026. Implementation is submitted on `codex/terrarium-implementation` for review before merging.

| Check                    | Result                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`             | Six packages built; zero errors.                                                                                                                                                                                        |
| `pnpm check`             | Both Svelte frontends: zero errors and zero warnings.                                                                                                                                                                   |
| `pnpm test`              | 66 tests passed: 15 shared-contract, 8 persistence, 13 provider/auth, 21 turn/scheduler, and 9 UI/socket integration cases. Terrain has no automated test files.                                                          |
| `pnpm dev`               | Server and primary UI start; package watchers compile without errors. Initial shared package output is built before watchers start.                                                                                     |
| Optional terrain         | `pnpm dev:terrain` starts the retained view separately.                                                                                                                                                                 |
| Startup paths            | Root and server-directory config loads resolve the same root database and loopback configuration. A temporary `DATABASE_PATH` passed through root development startup and created the selected test database.           |
| Missing compiled output  | Startup was exercised after moving all three shared-package `dist` directories to ignored backup locations. Initial builds completed before server startup.                                                             |
| Existing data            | Fresh and legacy-schema migrations succeed; repeated migration preserves history. The original legacy database SHA-256 remains `2E1CD30CAE0703B73671834796996DC7887173AC1E02A88A01D903CE0F972FE6`.                      |
| Browser workflow         | In a temporary world, saved a human message, room, and disabled agent; exercised Start/Pause/Stop; reloaded and confirmed configuration and saved conversation.                                                         |
| Real ChatGPT smoke check | User completed Terrarium sign-in. Model discovery included `gpt-6-luna`. One real turn returned `Terrarium connection verified.`, emitted one notification, and the saved message survived reopening its test database. |

## Failure and population coverage

Tests reject null, malformed, oversized, and unknown-room inputs. An injected save failure emits no successful conversation event. Both views receive the same committed record. A reconnect recovers 205 missed messages across multiple pages without duplication. Migration preserves legacy messages and their room references.

The scheduler test runs 16 configured agents at a one-millisecond cadence, verifies four-call concurrency and one active turn per agent, and proves pending agents are not starved by fast repeats. Other tests cover timeout exhaustion, rejection then recovery, pause completion, stop, late output after edits/disable/movement, and state-read failures. A late read failure cannot undo Stop. Notification failure after a committed action does not retry that action.

Context tests enforce the latest 50 current-room messages with speaker identity and history before arrival. Invalid JSON, empty speech, and unknown destinations do not mutate the world. Speech, movement, and waiting use the accepted-action boundary. Provider tests reject partial or failed streams, verify the catalog/request shapes and OAuth state/registration matching, and exercise Windows encryption and tamper detection.

## Limits of the evidence

The 16-agent scenario uses fake providers; it is not a long-duration live-model load test. The real Luna checks verify this account's current authentication and action path, not all models or prolonged refresh behavior. Browser checks are manual; socket recovery is automated. Development watchers briefly reconnect the UI while recompiling shared packages. Credentials and test databases are local ignored data and are excluded from the review branch.

## Strict action output follow-up

The earlier implementation requested JSON only through instructions and collapsed parse/schema failures into “The model returned an invalid action.” Increasing conversation complexity can compete with those instructions, but the old diagnostics did not retain enough evidence to identify the exact historical failures.

The approved fix sends a strict Responses JSON schema through the existing ChatGPT authentication path. A direct capability probe returned HTTP 200 and a valid wrapped wait action despite conflicting formatting instructions. Live stream inspection also established that this route sends completed message items before an empty final output list. The reader now handles that shape, separates commentary from the final action, and preserves diagnostic IDs.

Six real `gpt-6-luna` turns passed through the built provider, turn handler and world application: two each for speech, movement and waiting. Each used an isolated in-memory world with 50 synthetic messages containing competing suggestions, JSON examples and requests for other output formats; the second set used longer messages. All six returned the requested action, with the expected saved-message counts, movement and notifications. No production conversation was changed by these checks.

The 18 additional automated cases cover strict request formatting, authoritative completed output, empty final output lists, commentary separation, provider schema rejection without fallback, failed/incomplete/refused streams, multiple final messages, bounded provider diagnostics, full room history, invalid JSON/fields/length/destination, and detailed failure state after three attempts. Existing lifecycle, persistence and concurrency checks continue to pass.

A manual Socket.IO check against an isolated temporary server received `Attempt 3/3 failed`, the `action.message` field error, model, response ID, output length and bounded preview through `run:state`; no conversation message was saved. `pnpm build`, `pnpm check`, `pnpm test` and normal `pnpm dev` startup passed after the fix. The running application retains the existing account connection and starts stopped.

## JSON configuration follow-up

Seventeen additional automated cases cover file format/version/size validation, stable IDs and duplicate rejection, exclusion of runtime fields, complete settings round trips, merge semantics, preserved omitted records/history, invalidated agent revisions, unknown room references, stale previews and rollback after a later database write fails. Socket checks cover preview without writes, committed world/terrain notifications, running/paused import rejection, and blocking Start/competing writes during import. The import guard is released after failure. Existing fresh/legacy migration checks still pass; no migration or dependency was added.

Manual browser validation used a separate in-memory world and the config UI on port 4174. An invalid JSON file produced a visible error. A valid file previewed one updated room, one added room and one added agent before applying. The imported agent remained enabled while the run stayed stopped. Export downloaded a readable file with six rooms and one agent, excluding internal revision fields. Selecting that downloaded file previewed six updates and one agent update with no additions; applying succeeded, and reloading retained the saved configuration. Production configuration and conversation history were not changed by these browser checks.
