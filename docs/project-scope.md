# Terrarium Core project scope

Terrarium Core is a local AI conversation toy in which configurable agents inhabit rooms, observe conversation history, and take turns interacting. Development will extend the existing repository into a working, controllable terrarium, beginning with a web chat interface and a small population before exercising the same system with sixteen or more agents.

This is the proposed scope for review. Application implementation begins only after the user approves the [development plan](development-plan.md). The planning pull request changes documentation only.

## Product direction

Retain TypeScript, Svelte, a single Fastify server, Socket.IO, and SQLite through Kysely and better-sqlite3. Keep the existing application and package boundaries. Extend `apps/ui-config` into the initial web interface; retain `apps/ui-terrain` as an optional graphical view whose further development is deferred.

The server owns world operations and decides which model proposals become accepted actions. SQLite holds durable room configuration, agent configuration, room membership, and conversation history. In-flight requests and scheduler bookkeeping can remain in memory.

Personality is editable agent instructions. An MBTI-based starting population may be configuration data; the system must not require exactly sixteen agents or a fixed set of personality categories. Reuse the existing provider interface and the previously tested authentication integration referenced in the conversation once its source and usage contract are supplied.

## Current implementation

The baseline is commit `81e74a1f7f7c67759d0078b291a7c492f0e39ace`. Some capabilities listed in the root README are intended behavior, not implemented behavior.

| Area                 | What exists                                                                                                 | What remains                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Message delivery     | The config UI sends a test message; the server attempts to save it and broadcasts to the terrain namespace. | Runtime validation, success/error acknowledgements, a shared saved-message path, and history recovery. Failed inserts currently still broadcast. |
| Rooms and agents     | SQLite table definitions and five hardcoded room IDs in the server.                                         | Authoritative persisted configuration, editable persona/model settings, and membership operations.                                               |
| Conversation history | Message insertion into SQLite.                                                                              | History reads, reconnect recovery, and context assembly.                                                                                         |
| Agent execution      | An empty turn queue and a placeholder handler.                                                              | Initial scheduling, provider calls, bounded concurrency, lifecycle controls, and failure handling.                                               |
| Providers            | Five adapters implementing a common interface.                                                              | Real integration; every adapter currently returns mock output or configuration-error text.                                                       |
| Web interface        | A room list and test-message form.                                                                          | Conversation timeline, history browser, configuration, run controls, and activity/error state.                                                   |
| Terrain view         | Pixi room squares displaying the latest manual message.                                                     | A later graphical agent experience; `agent:update` currently only logs, and sockets do not join the rooms targeted by that event.                |

Source locations are [server](../apps/server/src/server.ts), [persistence](../packages/persistence/src/index.ts), [shared schemas](../packages/shared/src/index.ts), [provider interface](../packages/lm-providers/src/types.ts), [config UI](../apps/ui-config/src/App.svelte), and [terrain UI](../apps/ui-terrain/src/App.svelte).

## Next development scope

1. Stabilize local startup, environment/database paths, access boundaries, validated message storage and delivery, and history retrieval.
2. Complete one agent loop with persisted configuration, the existing authentication path, deliberate context assembly, validated actions, and controlled scheduling.
3. Expose that loop in the existing web app through readable conversations, room and agent configuration, run controls, and understandable activity/errors. Validate a small population before sixteen-plus agents.

The proposed initial action vocabulary is `speak`, `move`, and `wait`, subject to approval of the action contract. Technical errors must appear as operational errors, never as agent dialogue. The UI's room filter controls display, while server-side context rules determine what an agent can observe.

## Deferred scope

Defer relationship scores, separate long-term memory, judicial actions, additional graphical behavior, snapshots beyond current needs, and implementing every provider at once. Do not introduce a third frontend, a queue service, a distributed agent platform, a general action framework, a user-account system, or a replacement stack as part of this plan.

## First usable release

The first usable release lets a local operator configure rooms and agents, start and control a conversation, inspect saved history after reconnecting or restarting, and understand failures without reading server logs. Human and agent speech use the same reliable storage/delivery path. Moves update authoritative membership; stale model responses cannot mutate an invalid world state. The same configurable implementation supports a small trial and a sixteen-plus-agent trial within an approved request-concurrency limit.

Acceptance criteria, implementation boundaries, and unresolved decisions are in the [development plan](development-plan.md). Project tracking is in [Linear](https://linear.app/flamehorn-games/project/terrarium-core-1bb502640e5f/overview).
