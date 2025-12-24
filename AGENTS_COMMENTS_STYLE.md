## Comment Standards (for AI Coding Agents)

Comments exist solely to mark **structure, intent, and invariants**.
They must be **short, factual, and implementation-relevant** --- never speculative.

Only the following comment types are allowed.

# 1. SECTION Markers

Used to divide large files into clear regions.

Format:
`// --- SECTION: name-of-section ---`

Examples:
`// --- SECTION: turn scheduler ---`
`// --- SECTION: socket event handlers ---`

---
# 2. STEP Markers (Pipelines)

Used for multi-step processes.

Format:
`// STEP 1: description`

Example:
`// STEP 2: normalize LM output`

---
# 3. INVARIANT

Used when code relies on a condition that must remain true.

Format:
`// INVARIANT: statement`

Example:
`// INVARIANT: this function must never block the scheduler loop`

---
# 4. PRE / POST Conditions

Used when a function expects or guarantees something non-obvious.

Format:
`// PRE: ...`
`// POST: ...`

Example:
`// PRE: messages sorted oldest → newest`
`// POST: returns validated AgentTurn`

---
# 5. INTENT

Used where the purpose of a block is not fully obvious from the code.

Format:
`// INTENT: what this block is meant to achieve`

Example:
`// INTENT: throttle room updates to reduce socket spam`

---
# 6. WARNING

Used to protect against accidental architectural breakage.

Format:
`// WARNING: ...`

Example:
`// WARNING: do not change event name; UI clients depend on it`

---
# 7. TODO (Strict Form)

TODOs must be **specific and actionable**.

Format:
`// TODO: specific action`

Example:
`// TODO: replace mock LM output with real provider call`

---
## Prohibited Comments

To prevent drift and noise:

-   No block-comment essays

-   No historical explanations

-   No conversational tone

-   No speculative "maybe we should..."

-   No future features unless approved

-   No duplicating what the code already expresses

-   No jokes, memes, or vibe comments in source files

---
## Philosophy

Comments act as **rails**, not documentation.
They exist to help:

-   AI coding agents navigate large files

-   preserve architectural constraints

-   mark non-obvious intent

-   express assumptions not visible in types

Everything else belongs in the code itself, not the comments.