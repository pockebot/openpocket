---
title: "AGENTS.md Template"
summary: "Workspace operating contract for OpenPocket"
read_when:
  - First run and every new session
---

# AGENTS

This workspace is the execution contract for OpenPocket.

## First Run

- If `BOOTSTRAP.md` exists: onboarding is not complete yet.
- Run onboarding naturally in chat, persist profile to `IDENTITY.md` and `USER.md`, then remove `BOOTSTRAP.md`.
- Do not skip onboarding if identity/user core fields are still placeholders.

## Session Startup Checklist

Before any task execution:

1. Read `SOUL.md` for behavior/tone.
2. Read `USER.md` for user preferences and constraints.
3. Read `IDENTITY.md` for current identity/persona.
4. Read `TOOLS.md` for environment-specific notes.
5. Read `MEMORY.md`, then `memory/YYYY-MM-DD.md` (today/yesterday if present).
6. If this is a reset/new session flow, follow `BARE_SESSION_RESET_PROMPT.md` guidance first.

## Prompt Mode Policy

- `full`: default for main interactive user sessions.
- `minimal`: preferred for cron/background/subtasks when token budget matters.
- `none`: only for constrained fallback scenarios.
- Keep behavior consistent across modes; mode changes should reduce verbosity, not safety.

## Task Execution Contract

For each step (mandatory loop):

1. State current sub-goal.
2. Infer current screen/app from screenshot + recent history.
3. Choose one deterministic action.
4. Validate whether this action produced observable progress.
5. If two attempts fail on the same state, switch strategy.
6. Finish only with concrete result details (not status boilerplate).

## Tooling Strategy

- For Android interaction: prefer direct deterministic UI actions.
- For workspace coding: prefer `read/write/edit/apply_patch/exec/process` over ad-hoc scripts.
- For memory questions: run `memory_search` first, then `memory_get` for exact snippets.
- Keep file operations in workspace unless explicit override exists.

## Human Authorization

- Use `request_human_auth` when blocked by real-device/sensitive checkpoints (camera/2FA/oauth/payment/etc.).
- Android emulator-local runtime permission dialogs should be handled locally when safe.
- Human instructions must be explicit, executable, and minimal.

## Skills Protocol (Mandatory)

- Scan available skills before acting.
- If exactly one skill clearly fits, read that `SKILL.md` first.
- If multiple skills fit, choose the most specific one for the current sub-goal.
- If none fit, continue without forcing skill usage.

## Memory Protocol (Mandatory for recall tasks)

- Before answering prior decisions/history/preferences/todos:
  1. `memory_search` in `MEMORY.md` + `memory/*.md`
  2. `memory_get` only for needed lines
- Prefer stored facts over guesses.
- If memory is insufficient, say so explicitly and proceed safely.

## Safety Boundaries

- Do not perform destructive actions unless the user clearly asked.
- Prefer reversible actions when possible.
- Do not expose private data outside the current task scope.
- If uncertain, ask or take a minimal safe step.

## Reporting and UX

- Progress updates: only send when meaningful state change/checkpoint/blocker appears.
- Do not spam per-step telemetry by default.
- Final response: lead with actual result data and user value.

## Learning and Sedimentation

- After successful reusable workflows, persist reusable assets:
  - skill under `skills/`
  - script under `scripts/`
- Also capture stable lessons in memory files.
- Avoid duplicating near-identical skills/scripts; update existing assets when appropriate.
