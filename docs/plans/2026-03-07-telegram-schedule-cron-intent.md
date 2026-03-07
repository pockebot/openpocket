# Telegram Schedule Intent And Cron Automation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let implicit Telegram requests like `每天早上 8 点帮我打开某个 App` enter a confirmation-first scheduling flow, create a persisted calendar-aware cron job, and later trigger isolated agent runs that execute the phone task and report results back to the originating chat.

**Architecture:** Extend `ChatAssistant` routing with a structured `schedule_intent` mode instead of forcing all imperative text into immediate `task` execution. Add a first-class cron registry/service with `at / every / cron` schedule semantics and formal CRUD entry points (Gateway, CLI, agent tools) so job creation never depends on mutating `cron/jobs.json` directly. After user confirmation, run a short agent setup turn with only safe cron management tools enabled, then let `CronService` trigger the actual phone task later in an isolated `cron:<jobId>` session.

**Tech Stack:** TypeScript, Node.js `node:test`, OpenAI-backed `ChatAssistant` classification, OpenPocket gateway/runtime, `cron-parser` for calendar schedule evaluation.

---

### Task 1: Add Structured Schedule Intent Routing

**Files:**
- Modify: `src/types.ts`
- Modify: `src/gateway/chat-assistant.ts`
- Test: `test/chat-assistant.test.mjs`

**Step 1: Write failing tests**
- Add coverage for an implicit Chinese schedule request such as `每天早上 8 点帮我打开 Slack 去打卡`.
- Assert `ChatAssistant.decide()` returns a new mode like `schedule_intent` instead of `task`.
- Assert the decision includes:
  - normalized task text
  - parsed schedule fields (`kind`, `cron`, `timezone`, `summaryText`)
  - a confirmation-oriented reply preview
- Add a negative test that a plain capability question still returns `chat`.

**Step 2: Run tests (RED)**
- Run: `npm run build && node --test test/chat-assistant.test.mjs`
- Expected: FAIL because `ChatDecision.mode` only supports `"task" | "chat"` and no schedule payload exists.

**Step 3: Minimal implementation (GREEN)**
- In `src/types.ts`, add shared types for:
  - `CronScheduleSpec`
  - `ScheduleIntent`
  - `CronDeliveryTarget`
- Extend the `ChatDecision` shape in `src/gateway/chat-assistant.ts` to support `mode: "schedule_intent"`.
- Add a schedule-intent parser in `ChatAssistant` that:
  - recognizes strong temporal cues like `每天`, `每周`, `明天`, `8 点`
  - keeps the original task content separate from the schedule expression
  - produces a deterministic confirmation summary instead of an execution reply
- Keep fallback behavior conservative: ambiguous schedule phrases stay in `chat` or `task`, not silent auto-create.

**Step 4: Run tests (GREEN)**
- Run: `npm run build && node --test test/chat-assistant.test.mjs`
- Expected: PASS.

---

### Task 2: Add First-Class Cron Registry And New Job Schema

**Files:**
- Modify: `package.json`
- Modify: `src/types.ts`
- Create: `src/gateway/cron-registry.ts`
- Modify: `src/memory/workspace.ts`
- Test: `test/cron-registry.test.mjs`

**Step 1: Write failing tests**
- Add a new test file for registry behavior.
- Cover:
  - create/list/update/remove job
  - load/save a new schema job with `schedule.kind = "cron"`
  - migration from the existing legacy schema (`everySec`, `task`, `chatId`)
  - duplicate ID rejection
  - preserving `delivery.channel` and `delivery.to`

**Step 2: Run tests (RED)**
- Run: `npm run build && node --test test/cron-registry.test.mjs`
- Expected: FAIL because the registry module and new schema do not exist.

**Step 3: Minimal implementation (GREEN)**
- Add `cron-parser` to `package.json`.
- In `src/types.ts`, replace the old flat cron job structure with a richer model:
  - `schedule: { kind: "cron" | "at" | "every"; expr?; at?; everyMs?; tz }`
  - `payload: { kind: "agent_turn"; task: string }`
  - `delivery: { mode: "announce"; channel: string; to: string }`
  - metadata fields like `createdAt`, `updatedAt`, `createdBy`, `sourceChannel`, `sourcePeerId`
- Create `src/gateway/cron-registry.ts` as the only read/write owner of the jobs file.
- Support legacy load migration so existing `everySec` jobs still work after one save.
- Update `src/memory/workspace.ts` README/bootstrap content to document the new schema and explicitly say that runtime mutation should go through commands/tools, not manual editing while the gateway is running.

**Step 4: Run tests (GREEN)**
- Run: `npm run build && node --test test/cron-registry.test.mjs`
- Expected: PASS.

---

### Task 3: Add CLI Cron CRUD Commands

**Files:**
- Modify: `src/cli.ts`
- Modify: `README.md`
- Test: `test/cli.test.mjs`

**Step 1: Write failing tests**
- Add CLI coverage for:
  - `openpocket cron list`
  - `openpocket cron add --name ... --cron "0 8 * * *" --tz Asia/Shanghai --task "..."`
  - `openpocket cron remove --id ...`
  - `openpocket cron run --id ...`
- Assert the commands call the new registry/service layer rather than editing files inline.

**Step 2: Run tests (RED)**
- Run: `npm run build && node --test test/cli.test.mjs`
- Expected: FAIL because `cron` is not a supported top-level CLI command.

**Step 3: Minimal implementation (GREEN)**
- Add a new `runCronCommand()` entry in `src/cli.ts`.
- Support subcommands:
  - `list`
  - `add`
  - `remove`
  - `run`
  - `disable`
  - `enable`
- Reuse `CronRegistry` for persistence and `CronService.runNow()` for manual triggering.
- Print a stable, human-readable summary after `add`, including the next run time and delivery target.
- Add a short README section showing the canonical CLI path for cron management.

**Step 4: Run tests (GREEN)**
- Run: `npm run build && node --test test/cli.test.mjs`
- Expected: PASS.

---

### Task 4: Add Confirmation-First Gateway Flow For Schedule Intent

**Files:**
- Modify: `src/gateway/gateway-core.ts`
- Modify: `src/gateway/chat-assistant.ts`
- Test: `test/channel-gateway-core.test.mjs`

**Step 1: Write failing tests**
- Add gateway tests covering:
  - an inbound Telegram-like plain message with implicit schedule language returns a confirmation message instead of enqueuing a phone task
  - replying `确认` creates a pending automation setup action
  - replying `取消` clears the pending schedule request
  - an unrelated message while confirmation is pending prompts the user to confirm/cancel first

**Step 2: Run tests (RED)**
- Run: `npm run build && node --test test/channel-gateway-core.test.mjs`
- Expected: FAIL because `GatewayCore.handlePlainMessage()` only understands `task` and `chat`.

**Step 3: Minimal implementation (GREEN)**
- Add a per-peer pending confirmation store in `GatewayCore`.
- When `ChatDecision.mode === "schedule_intent"`:
  - do not call `enqueueTask()`
  - save the parsed intent
  - reply with a deterministic confirmation message
- Intercept `确认` / `取消` (and English equivalents) before normal routing when a confirmation is pending.
- Keep the confirmation TTL short and clear pending state after success or cancellation.

**Step 4: Run tests (GREEN)**
- Run: `npm run build && node --test test/channel-gateway-core.test.mjs`
- Expected: PASS.

---

### Task 5: Expose Safe Cron Tools To The Agent And Allow Tool-Scoped Setup Runs

**Files:**
- Modify: `src/types.ts`
- Modify: `src/agent/tools.ts`
- Modify: `src/agent/actions.ts`
- Modify: `src/agent/agent-runtime.ts`
- Modify: `src/agent/runtime/types.ts`
- Modify: `src/gateway/gateway-core.ts`
- Test: `test/actions.test.mjs`
- Test: `test/agent-runtime.test.mjs`
- Test: `test/channel-gateway-core.test.mjs`

**Step 1: Write failing tests**
- Add action/tool coverage for:
  - `cron_add`
  - `cron_list`
  - `cron_remove`
  - `cron_update`
- Add runtime coverage that a caller can override `availableToolNames` for a specific run.
- Add gateway coverage that after user confirmation, the setup run uses a restricted tool set and does not start phone actions.

**Step 2: Run tests (RED)**
- Run: `npm run build && node --test test/actions.test.mjs test/agent-runtime.test.mjs test/channel-gateway-core.test.mjs`
- Expected: FAIL because cron tools and caller-scoped tool overrides do not exist.

**Step 3: Minimal implementation (GREEN)**
- Add formal cron management tools backed by `CronRegistry`, not by file-editing tools.
- Extend `AgentRuntime.runTask()` and `RunTaskRequest` so `GatewayCore` can pass an explicit `availableToolNames` override.
- After the user replies `确认`, make `GatewayCore` launch a short setup run with only:
  - `cron_add`
  - `cron_list`
  - `finish`
- Use a deterministic task prompt like:
  - `Create exactly one cron job from this confirmed intent...`
- Reject any attempt in this setup run to use phone actions or coding file writes.

**Step 4: Run tests (GREEN)**
- Run: `npm run build && node --test test/actions.test.mjs test/agent-runtime.test.mjs test/channel-gateway-core.test.mjs`
- Expected: PASS.

---

### Task 6: Upgrade CronService To Calendar Scheduling And Isolated Execution Sessions

**Files:**
- Modify: `src/gateway/cron-service.ts`
- Modify: `src/gateway/gateway-core.ts`
- Test: `test/cron-service.test.mjs`
- Test: `test/channel-gateway-core.test.mjs`

**Step 1: Write failing tests**
- Add service coverage for:
  - due evaluation from a cron expression at a specific wall-clock time
  - one-shot `at` jobs firing once and then disabling/removing themselves
  - `every` jobs still working after legacy migration
  - recording `nextRunAt`, `lastRunAt`, `lastStatus`, `lastError`
- Add gateway coverage that triggered jobs run in `cron:<jobId>` sessions and report back to the configured Telegram peer.

**Step 2: Run tests (RED)**
- Run: `npm run build && node --test test/cron-service.test.mjs test/channel-gateway-core.test.mjs`
- Expected: FAIL because the current cron service only checks `everySec`.

**Step 3: Minimal implementation (GREEN)**
- Replace `everySec` due logic with schedule-aware next-run computation.
- Persist richer state:
  - `lastAttemptAt`
  - `lastRunAt`
  - `lastStatus`
  - `lastError`
  - `nextRunAt`
- Update `GatewayCore.runScheduledJob()` to:
  - use `sessionKey = "cron:<jobId>"`
  - announce start/end to the original chat from `delivery`
  - skip reuse of normal DM conversational context
- Keep `source = "cron"` prompt mode minimal for triggered runs.

**Step 4: Run tests (GREEN)**
- Run: `npm run build && node --test test/cron-service.test.mjs test/channel-gateway-core.test.mjs`
- Expected: PASS.

---

### Task 7: Finish Surface Polish And Regression Checks

**Files:**
- Modify: `src/channel/telegram/adapter.ts`
- Modify: `src/gateway/gateway-core.ts`
- Modify: `README.md`
- Test: `test/channel-gateway-core.test.mjs`
- Test: `test/cli.test.mjs`

**Step 1: Write failing tests**
- Add help-surface assertions for any new command text, such as `/cronrun` help expanding to mention CLI or `/cron list` style guidance if you expose it in chat help.
- Add regression coverage that normal immediate tasks still execute unchanged.

**Step 2: Run tests (RED)**
- Run: `npm run build && node --test test/channel-gateway-core.test.mjs test/cli.test.mjs`
- Expected: FAIL if help text and regression assertions are not updated.

**Step 3: Minimal implementation (GREEN)**
- Update chat help/menu text only where necessary.
- Document:
  - implicit schedule intent
  - confirmation-first behavior
  - CLI cron commands
  - isolated cron session behavior
- Keep wording explicit that schedule creation is confirmed before persistence.

**Step 4: Run focused tests (GREEN)**
- Run: `npm run build && node --test test/chat-assistant.test.mjs test/channel-gateway-core.test.mjs test/cron-registry.test.mjs test/cron-service.test.mjs test/cli.test.mjs test/agent-runtime.test.mjs`
- Expected: PASS.

**Step 5: Run broader verification**
- Run: `npm run build && node --test test/*.test.mjs`
- Expected: PASS.
