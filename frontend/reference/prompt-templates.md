# Prompt Templates

This page documents runtime prompt templates used by both task loop and chat gateway flows.

## Task System Prompt (`buildSystemPrompt`)

`buildSystemPrompt(skillsSummary, workspaceContext, { mode })` supports three modes.

### `full` (default)

Includes complete policy stack:

- Tooling catalog (all task tools):
  - Android actions: `tap`, `swipe`, `drag`, `long_press_drag`, `type_text`, `keyevent`, `launch_app`, `shell`, `wait`, `finish`
  - script fallback: `run_script`
  - coding tools: `read`, `write`, `edit`, `apply_patch`, `exec`, `process`
  - memory tools: `memory_search`, `memory_get`
  - auth tool: `request_human_auth`
- Mandatory planning loop (sub-goal, screen inference, deterministic next action, anti-loop switch)
- Execution policy (focus anti-loop, avoid repetitive taps, no internal-log typing, practical reproducibility)
- Human-authorization policy (in-emulator permission dialogs handled locally; real-device checkpoints use `request_human_auth`)
- Completion policy (lead `finish.message` with concrete result values)
- Output discipline (exactly one tool per step, thought in English)
- Skill selection protocol
- Memory recall protocol (search first, then targeted read)
- Messaging and runtime discipline
- Self-learning/reuse guidance for reusable flows
- Available skills summary and workspace context block

### `minimal`

Condensed prompt for lower-noise runs (used by cron tasks):

- one-tool-per-step
- deterministic progress
- permission and human-auth basics
- finish with key outputs
- includes skills + workspace context when available

### `none`

Minimal safety skeleton:

- one-step tool call
- permission dialog local handling
- real auth via `request_human_auth`
- finish with concise result

## Task User Prompt (`buildUserPrompt`)

Per step, runtime builds a decision prompt with:

- task text + step number
- structured screen metadata (`currentApp`, scaled width/height, device id, timestamp)
- recent execution history (last 8 lines)
- stuck signals:
  - trailing action streak
  - trailing app streak
  - unknown-app streak
  - focus-loop risk
- decision checklist:
  - active sub-goal
  - evidence-based next action
  - anti-loop alternative path
  - text-entry policy (max focus taps, then type and submit)
  - forbid typing logs/history/JSON
  - permission/auth policy reminder
  - finish criteria

The screenshot is attached as base64 image in model payload.

## Workspace Context Injection

Runtime injects workspace files into system prompt context (subject to char budgets):

- `AGENTS.md`
- `BOOTSTRAP.md`
- `SOUL.md`
- `USER.md`
- `IDENTITY.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `MEMORY.md`
- `TASK_PROGRESS_REPORTER.md`
- `TASK_OUTCOME_REPORTER.md`

Optional hook (injected first):

- `.openpocket/bootstrap-context-hook.md`

Budget policy:

- per file max: `20,000` chars
- total max: `agent.contextBudgetChars` (default `150,000`)
- truncation strategy: head+tail with explicit middle-truncation marker

## Prompt Observability

`AgentRuntime` generates a prompt-context report containing:

- prompt mode
- system prompt total chars
- workspace/non-workspace char split
- per-file inclusion/truncation/missing/budget-exhausted status
- skill summary char usage
- tool list/schema char usage

Gateway exposes this via `/context [list|detail|json]`.

## Onboarding Prompt Templates (Chat Assistant)

### Bootstrap onboarding conductor

`ChatAssistant` builds a strict-JSON prompt that includes:

- `BOOTSTRAP.md`
- `SOUL.md`
- current `IDENTITY.md` and `USER.md`
- recent onboarding conversation turns
- locale hint and current profile snapshot

Model output contract:

```json
{
  "reply": "...",
  "profile": {
    "userPreferredAddress": "...",
    "assistantName": "...",
    "assistantPersona": "...",
    "userName": "...",
    "timezone": "...",
    "languagePreference": "..."
  },
  "writeProfile": true,
  "onboardingComplete": false
}
```

Completion requires all required fields:

- `userPreferredAddress`
- `assistantName`
- `assistantPersona`

### Locale onboarding template

`PROFILE_ONBOARDING.json` provides locale text for:

- step questions
- empty-answer prompt
- saved/update/no-change confirmations
- persona presets and aliases
- default fallback values

## Session Reset Prompt Template

`BARE_SESSION_RESET_PROMPT.md` provides reset/startup guidance text used after `/reset` when onboarding is not pending.

## Task Narration Prompt Templates

### Progress narrator

Prompt source:

- `TASK_PROGRESS_REPORTER.md`
- compact recent progress context
- locale hint + profile context (`SOUL.md`, `IDENTITY.md`, `USER.md`)

Model output contract:

```json
{
  "notify": true,
  "message": "...",
  "reason": "..."
}
```

Rules include:

- silence on low-signal/no-visible-progress loops
- notify on meaningful checkpoints/errors/auth blockers
- avoid step counters unless user requested telemetry
- natural conversational tone

### Outcome narrator

Prompt source:

- `TASK_OUTCOME_REPORTER.md`
- task result, recent progress summary, and artifact flags
- profile context (`SOUL.md`, `IDENTITY.md`, `USER.md`)

Model output contract:

```json
{
  "message": "..."
}
```

Rules include:

- lead with concrete findings
- avoid boilerplate status-first phrasing
- for failures, include practical next move
- mention reusable artifacts briefly when generated
