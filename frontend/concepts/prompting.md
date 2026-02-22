# Prompting and Decision Model

This page explains how OpenPocket builds prompts across onboarding, task execution, and user-facing narration.

## Task Prompt Stack

### System prompt

`buildSystemPrompt(skillsSummary, workspaceContext, { mode })` builds policy instructions for the task loop.

Core layers in `full` mode:

- complete tool catalog (Android actions + script + coding + memory + human auth)
- mandatory planning loop and anti-loop strategy switch
- execution policy for deterministic one-step actions
- permission/auth policy
- completion policy (result-first `finish.message`)
- skill-selection protocol
- memory-recall protocol (`memory_search` -> `memory_get`)
- self-learning/reuse guidance

Modes:

- `full` (default)
- `minimal` (used by cron runs)
- `none` (minimal safety shell)

### User prompt (per step)

`buildUserPrompt(task, step, snapshot, history)` includes:

- task + step
- screen metadata and scaled coordinate bounds
- recent history
- stuck indicators (`action streak`, `app streak`, `unknown-app streak`, `focus-loop risk`)
- explicit decision checklist

The screenshot is attached as image input in the same model request.

## Workspace Context Injection

Runtime injects workspace prompt files into system prompt context:

- `AGENTS.md`, `BOOTSTRAP.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`
- `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`
- `TASK_PROGRESS_REPORTER.md`, `TASK_OUTCOME_REPORTER.md`

Optional pre-hook:

- `.openpocket/bootstrap-context-hook.md`

Budget strategy:

- per file: up to `20,000` chars
- total: `agent.contextBudgetChars` (default `150,000`)
- truncation uses head+tail keep with explicit marker

## Prompt Observability

`AgentRuntime` generates a prompt report (system size, per-file status, skill/tool budget usage).

Gateway command `/context` exposes this report in:

- summary list
- detailed breakdown
- raw JSON

## Onboarding Prompting

Chat onboarding is model-driven when profile is incomplete.

Inputs to onboarding conductor prompt:

- `BOOTSTRAP.md`
- locale hint
- profile snapshot from `IDENTITY.md` + `USER.md`
- recent onboarding turns
- `SOUL.md`

Model returns strict JSON (`reply`, profile patch, `writeProfile`, `onboardingComplete`).

Template support:

- `PROFILE_ONBOARDING.json` provides locale questions, persona presets, and confirmations
- `BARE_SESSION_RESET_PROMPT.md` controls post-`/reset` startup guidance when onboarding is already complete

## Progress and Outcome Prompting

During task execution, gateway does not hardcode per-step text.
It asks model narrators with structured context.

### Progress narrator

- prompt guide: `TASK_PROGRESS_REPORTER.md`
- output JSON: `{ notify, message, reason }`
- notify only on meaningful user-visible progress
- avoid step counters unless user asked for telemetry

### Outcome narrator

- prompt guide: `TASK_OUTCOME_REPORTER.md`
- output JSON: `{ message }`
- lead with concrete results
- avoid generic "task completed" boilerplate when result data exists

Gateway adds extra suppression to avoid repetitive low-signal updates on the same screen.

## Output Contract and Safety

- model must call exactly one tool per step
- tool args are normalized to `AgentAction`
- unknown/malformed actions degrade to safe `wait`
- in-emulator Android permission dialogs are auto-approved locally
- `request_human_auth` is reserved for real-device checkpoints and sensitive authorization flows

## Chat Routing

`ChatAssistant.decide(chatId, inputText)` routing order:

1. bootstrap/profile onboarding gates
2. profile update intent check (name/persona/address)
3. model classification (`task` vs `chat`)
4. fallback to `task` if classifier fails

Task mode delegates to `AgentRuntime.runTask`.
Chat mode replies conversationally.
