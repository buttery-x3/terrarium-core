# Terrarium Core project scope

Terrarium Core is a local AI conversation toy in which configurable agents inhabit rooms, observe conversation history, and take turns interacting. It extends this repository with a controllable web interface, durable history, and ChatGPT-authenticated agents. The same configuration supports a small population and sixteen or more agents.

The original implementation was merged into `main` at `b1eea79`. The user approved the FLAME-146 plan and defaults on 18 October 2026; the extension is implemented on `codex/flame-146`.

## Product and architecture

Retain TypeScript, Svelte, one Fastify server, Socket.IO, and SQLite through Kysely and better-sqlite3. The server validates model proposals and owns world operations. SQLite stores rooms, agent configuration, current membership, and conversation history. Active calls and scheduling remain in memory.

Personality retains the existing editable `instructions` field. Motivations and optional operator-configured intention are separate text sections. Shared behavioural prompting, energy policy and diagnostic retention are operator settings. No schema fixes population size or personality categories. `apps/ui-config` is the primary web interface; `apps/ui-terrain` remains optional. Authentication uses the existing protected ChatGPT connection.

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
| Actions             | `speak`, `move`, `wait`, `eat`. Destinations and agent/run revisions are validated before mutation. Technical failures remain operational errors.                                               |
| Scheduling          | One active turn per agent, four concurrent requests, 60-second attempts, two retries. Pause finishes active work; stop/disable/edits/movement discard stale results.                     |
| Web interface       | Timeline, older messages, reconnect recovery, room/agent forms, ChatGPT connection, run controls, activity/error feedback.                                                               |
| Terrain             | Optional existing Pixi view consumes the shared conversation event. Further graphical development remains deferred.                                                                      |

Implementation: [server](../apps/server/src/app.ts), [scheduler](../apps/server/src/scheduler.ts), [turns](../apps/server/src/turns.ts), [persistence](../packages/persistence/src/world.ts), [schemas](../packages/shared/src/index.ts), [ChatGPT provider](../packages/lm-providers/src/chatgpt.ts), [web UI](../apps/ui-config/src/App.svelte), [terrain UI](../apps/ui-terrain/src/App.svelte).

## FLAME-146 extension

Rooms have an explicit food-source capability. The authoritative action vocabulary includes `eat`; movement and eating are separate turns. Energy starts disabled, uses elapsed running time independently of turn cadence, and preserves current values across Stop/restart. The approved defaults are 100 initial/maximum, 5 points per running minute, low at 25 or below, and meals filling to maximum. Zero energy does not restrict actions. There is no food inventory or automatic movement/eating.

Model context contains own profile/energy, local identities and recent room history, plus a static room directory with food capabilities. Other agents' profiles, remote occupancy/activity/transcripts and operator diagnostics are excluded. The existing pre-arrival recent-message policy remains.

The operator can edit five shared behavioural sections and preview the assembled request without consuming a turn. Immutable attempt snapshots contain the exact submitted provider body, final action output and application result. Diagnostics persist in SQLite, distinguish successful actions from failures and interruptions, retain deleted-agent names, support bounded filtering/detail views and JSON export, and never become agent memory. Conversation clearing explicitly retains diagnostic copies until separately cleared.

Version-2 configuration includes these authored settings; version-1 imports preserve existing newer values and disclose defaults for new records. Runtime energy and diagnostic history are excluded from configuration files. No dependencies, authentication changes or terrain expansion were added.

## Deferred scope

Relationship scores, separate long-term memory, judicial actions, additional graphical behavior, snapshots beyond current needs, and implementation of every provider remain deferred. This release introduces no third frontend, queue service, distributed agent platform, general action framework, user-account system, or replacement stack. An MBTI population can be manually configured; it is not automatically seeded.

## Release boundaries

This is a local single-operator application. ChatGPT credential protection currently requires Windows. Keep one server process per database/credential store. Runs start stopped after restart; enabled flags do not automatically start model calls. Pause is temporary runtime state, not a saved run snapshot. Other provider adapters are not exposed in the product.

See [local development](local-development.md), [validation evidence](implementation-validation.md), and [Linear](https://linear.app/flamehorn-games/project/terrarium-core-1bb502640e5f/overview).
