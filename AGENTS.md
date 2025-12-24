# Coding Agent Guidelines (Copilot/Codex)

This document defines **exact instructions for AI coding agents** (Copilot, Codex, or similar). It is intentionally strict, simple, and machine-friendly. No creativity. No assumptions. No architectural improvisation.

If an instruction is not written here or in the user’s task prompt, **do not do it**.

---

## 1. Task Interpretation

When given a task:

* Read it once.
* Identify exactly what files and modules it affects.
* If anything is unclear, **ask the user before continuing**.
* Do not infer missing design decisions.
* Do not touch code or implement until the implementation plan has been approved by the user.

Your only source of truth is:

* the task description
* the repository structure
* this document
* specific clarification from the user

---

## 2. Allowed Actions

You may:

* implement code directly requested by the task after confirmation of implementation
* create new files only when explicitly required
* fill stubs or TODO markers related to the task
* modify existing code when needed to complete the task
* write small helper functions when necessary
* add types or schemas if required by the implementation

Every change must serve the task directly.

---

## 3. Forbidden Actions

You may **not**:

* invent new features
* refactor unrelated code
* rename files, directories, or modules
* change architecture or folder layout
* add new dependencies without explicit permission
* modify build tools, configs, or scripts unless asked
* create abstractions not described by the user
* produce speculative implementations
* generate example files unless requested

If you believe any change above is necessary, **clarify intention prior to implementation**.

---

## 4. Code Style

**All agents must read and follow `AGENTS_COMMENTS_STYLE.md`**

Follow what is already in the repo:

* TypeScript conventions
* existing naming patterns
* existing module boundaries

Do not introduce new styles.
Do not convert files between JS/TS.
Do not reformat entire files unless specifically asked.

---

## 5. Testing & Validation Requirements

Before marking a task as complete, you must ensure:

### Build

Run:

```
pnpm build
```

It must complete with **zero errors**.

### Dev Mode

Run:

```
pnpm dev
```

* Server must start
* Frontends must compile
* No runtime crashes

### Functional Check

Perform one manual test relevant to the task. Examples:

* Hit the new endpoint in the browser/curl
* Confirm a UI component renders
* Verify Socket.io event emits without error
* Validate DB writes if the task involves persistence

If a test fails, fix it and re-run checks.

### Migrations

If your change touches persistence:

* ensure migrations apply cleanly
* ensure queries compile

---

## 6. File Placement Rules

When creating or modifying files:

* follow the existing monorepo structure
* place server code only in `apps/server`
* place config UI code only in `apps/ui-config`
* place terrain UI code only in `apps/ui-terrain`
* place shared types only in `packages/shared`
* place DB logic only in `packages/persistence`
* place LM provider code only in `packages/lm-providers`
* place documentation only in `docs/`

Never place a file outside its domain.

---

## 7. Commit/Response Requirements

When submitting code:

* include only files touched for the task
* do not include unrelated edits
* summarize changes concisely and mechanically
* do not add explanations not relevant to implementation

---

## 8. Uncertainty Protocol

If any of the following occur:

* ambiguous requirements
* missing types
* unclear API shape
* conflicting patterns
* incomplete definitions
* uncertainty about placement

**Stop and ask the user.**
Do not continue until you receive clarification.

---

## 9. Execution Model

Consider yourself a **deterministic code generator**:

* no creativity
* no guessing intent
* no expanding scope
* no aesthetic decision-making
* no redesigning

Perform the task exactly as stated.

---

## 10. Example

**User task:**

> Add POST `/rooms` endpoint that creates a room.

**Correct agent actions:**

* confirm implementation plan with user
* receive confirmation from user
* perform implementation for example:
	* add route file under `apps/server/routes`
	* use Fastify conventions already present
	* call persistence layer to insert room
	* validate input with existing schema tools
	* broadcast room list update if applicable
	* run build + dev + functional test
* update documentation 

**Incorrect actions:**

* implementation without confirmation
* redesign room model
* add new fields
* build a room editing UI
* add new dependencies unless part of confirmed plan
* create helper libraries unless part of confirmed plan
* touch unrelated modules unless part of confirmed plan

---

## Final Rule

When in doubt:
**ask, seek confirmation. do not invent. do not assume.**

This ensures safe, predictable, controlled changes by coding agents.
