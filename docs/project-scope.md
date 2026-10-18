# Terrarium Core project scope

Terrarium Core is a local AI conversation toy in which configurable agents inhabit rooms, observe conversation history, and take turns interacting. It extends this repository with a controllable web interface, durable history, and ChatGPT-authenticated agents. The same configuration supports a small population and sixteen or more agents.

The user approved the [development plan](development-plan.md) and implementation choices on 18 October 2026. Implementation is on `codex/terrarium-implementation`, pending review; it has not been merged into `main`.

## Product and architecture

Retain TypeScript, Svelte, one Fastify server, Socket.IO, and SQLite through Kysely and better-sqlite3. The server validates model proposals and owns world operations. SQLite stores rooms, agent configuration, current membership, and conversation history. Active calls and scheduling remain in memory.

Personality is editable instructions. No schema fixes population size or personality categories. `apps/ui-config` is the primary web interface; `apps/ui-terrain` remains optional. Authentication uses the working ChatGPT path supplied through Flamehorn Desktop and social-summarizer-extension, with Terrarium's own protected credentials.

## Implemented for review

| Area                | Behavior                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup and access  | Initial package builds precede watchers. Root environment/database paths are explicit. The API binds to loopback; socket controls accept approved local UI origins.                      |
| Messages            | Runtime validation, save before broadcast, one saved record for config and terrain views, success/error acknowledgements. Human and agent speech use the same insertion operation.       |
| History             | Stable timestamp/ID ordering, 100-record pages, room filtering, live delivery merged by message ID; reconnect refreshes saved history. |
| Conversation export | Download one Markdown transcript for every room with full saved history, speaker names, timestamps and empty-room markers. Uses a consistent snapshot in any run state. |
| Conversation clearing | Confirm permanent deletion for the current room or all rooms while stopped. Preserve room/agent settings; reset both views and agent context, reject stale history responses and late turns. |
| World configuration | Versioned migration preserves messages. Five initial rooms; no automatic agents. Create/edit rooms and create/edit/disable/delete agents; persisted membership. Agent deletion requires confirmation, cancels its turn and preserves past messages. |
| Configuration files | Export all room/agent settings as versioned JSON; validate and preview imports; merge by ID in one transaction while stopped. Preserve omitted records and history. |
| Agents              | Editable name, instructions, model, cadence, context limit, room, enabled state. Context includes latest 1–50 current-room messages, including before arrival.                           |
| Model integration   | ChatGPT OAuth with PKCE and verified identity, Windows protected storage, model discovery, completed Responses streams. Initial model: `gpt-6-luna`. Other adapters remain unused mocks. |
| Actions             | `speak`, `move`, `wait`. Destinations and agent/run revisions are validated before mutation. Technical failures remain operational errors.                                               |
| Scheduling          | One active turn per agent, four concurrent requests, 60-second attempts, two retries. Pause finishes active work; stop/disable/edits/movement discard stale results.                     |
| Web interface       | Timeline, older messages, reconnect recovery, room/agent forms, ChatGPT connection, run controls, activity/error feedback.                                                               |
| Terrain             | Optional existing Pixi view consumes the shared conversation event. Further graphical development remains deferred.                                                                      |

Implementation: [server](../apps/server/src/app.ts), [scheduler](../apps/server/src/scheduler.ts), [turns](../apps/server/src/turns.ts), [persistence](../packages/persistence/src/world.ts), [schemas](../packages/shared/src/index.ts), [ChatGPT provider](../packages/lm-providers/src/chatgpt.ts), [web UI](../apps/ui-config/src/App.svelte), [terrain UI](../apps/ui-terrain/src/App.svelte).

## Deferred scope

Relationship scores, separate long-term memory, judicial actions, additional graphical behavior, snapshots beyond current needs, and implementation of every provider remain deferred. This release introduces no third frontend, queue service, distributed agent platform, general action framework, user-account system, or replacement stack. An MBTI population can be manually configured; it is not automatically seeded.

## Release boundaries

This is a local single-operator application. ChatGPT credential protection currently requires Windows. Keep one server process per database/credential store. Runs start stopped after restart; enabled flags do not automatically start model calls. Pause is temporary runtime state, not a saved run snapshot. Other provider adapters are not exposed in the product.

See [local development](local-development.md), [validation evidence](implementation-validation.md), and [Linear](https://linear.app/flamehorn-games/project/terrarium-core-1bb502640e5f/overview).
