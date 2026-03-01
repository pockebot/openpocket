# OpenPocket Pi Coding Agent Full Adoption Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make OpenPocket use `@mariozechner/pi-coding-agent` as the primary coding runtime while preserving Android emulator control in the same agent loop.

**Architecture:** Replace the current split execution model (`CodingExecutor` + `AdbRuntime` + custom loop) with a single `createAgentSession()`-driven loop. Keep Android actions as custom tools registered into the pi coding session, and route Telegram/Gateway progress from session events. Migrate in incremental PRs with compatibility toggles and contract tests at each step.

**Tech Stack:** TypeScript, Node.js 20+, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, Node test runner (`node --test`), existing OpenPocket gateway/runtime modules.

## PR-00: Capability Contract Baseline

**Files:**
- Create: `test/coding-runtime-contract.test.mjs`
- Create: `test/telegram-coding-smoke.contract.test.mjs`
- Modify: `package.json` (optional test script aliases)

**Step 1: Write failing contract tests**
Add tests for:
1. Telegram instruction `"创建文件 smoke_out/main.js ..."` ends with file written and task success.
2. `"可以吗"` style phrasing with executable intent can be forced into task mode.
3. Coding action chain includes read/write/edit/bash-style execution capability contract.

**Step 2: Run tests to confirm failures**
Run: `node --test test/coding-runtime-contract.test.mjs test/telegram-coding-smoke.contract.test.mjs`
Expected: FAIL on missing unified runtime behavior.

**Step 3: Add minimal harness utilities**
Add reusable mocks/utilities to isolate gateway/runtime behavior in tests without emulator dependency.

**Step 4: Re-run targeted tests**
Run: `node --test test/coding-runtime-contract.test.mjs test/telegram-coding-smoke.contract.test.mjs`
Expected: Still FAIL, but deterministic and readable.

**Step 5: Commit**
`git commit -m "test(runtime): add pi-coding-agent adoption contract baseline"`

**Acceptance:**
1. Contract tests exist and fail for the right reasons.
2. Existing test suite still runs.

**Rollback:**
Revert only new test files from this PR.

## PR-01: AgentSession Bridge Skeleton

**Files:**
- Create: `src/agent/pi-session-bridge.ts`
- Create: `src/agent/pi-session-events.ts`
- Modify: `src/agent/runtime/attempt.ts`
- Modify: `src/types.ts`
- Test: `test/pi-session-bridge.test.mjs`

**Step 1: Write failing bridge tests**
Validate:
1. Bridge can create `createAgentSession()` with injected model/auth/settings.
2. Bridge forwards prompt and receives event stream.
3. Bridge supports cancellation and clean dispose.

**Step 2: Run tests**
Run: `node --test test/pi-session-bridge.test.mjs`
Expected: FAIL due to missing bridge.

**Step 3: Implement minimal bridge**
Implement adapter that:
1. Builds a pi coding session.
2. Exposes `prompt()`, `abort()`, `dispose()`.
3. Emits normalized events for OpenPocket runtime.

**Step 4: Run tests**
Run: `node --test test/pi-session-bridge.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat(agent): add pi-coding-agent session bridge skeleton"`

**Acceptance:**
1. Bridge is isolated and test-covered.
2. No behavior change for production runtime path yet.

**Rollback:**
Remove bridge files and revert `attempt.ts` references.

## PR-02: Coding Tools Switch (Primary Path)

**Files:**
- Create: `src/agent/pi-coding-tools.ts`
- Modify: `src/agent/runtime/attempt.ts`
- Modify: `src/agent/tools.ts`
- Modify: `src/config/index.ts`
- Test: `test/pi-coding-tools-adapter.test.mjs`

**Step 1: Write failing tool-path tests**
Validate:
1. `read/write/edit/bash` are routed through pi coding tools.
2. Existing OpenPocket `exec/process/apply_patch` remains behind compatibility flag.
3. Workspace boundary enforcement still applies.

**Step 2: Run tests**
Run: `node --test test/pi-coding-tools-adapter.test.mjs`
Expected: FAIL.

**Step 3: Implement primary-path switch**
1. Register pi coding tools as default coding toolset.
2. Keep legacy `CodingExecutor` as fallback (`config.agent.legacyCodingExecutor`).
3. Add clear logs indicating active coding backend.

**Step 4: Run tests**
Run: `node --test test/pi-coding-tools-adapter.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat(agent): switch primary coding path to pi-coding-agent tools"`

**Acceptance:**
1. Coding actions use pi tool path by default.
2. Legacy path still available by config toggle.

**Rollback:**
Flip default back to legacy and revert adapter wiring.

## PR-03: Android Tools as Custom Tools in AgentSession

**Files:**
- Create: `src/agent/android-custom-tools.ts`
- Modify: `src/agent/runtime/attempt.ts`
- Modify: `src/device/adb-runtime.ts`
- Test: `test/android-custom-tools.test.mjs`

**Step 1: Write failing custom-tool tests**
Validate custom tools:
1. `tap/swipe/type/keyevent/launch_app/shell` execute through `AdbRuntime`.
2. Tool results include normalized text and error surfaces.
3. Snapshot refresh hooks fire after state-changing actions.

**Step 2: Run tests**
Run: `node --test test/android-custom-tools.test.mjs`
Expected: FAIL.

**Step 3: Implement Android custom tools**
1. Register Android tools alongside pi coding tools in same session.
2. Normalize `shell` semantics for complex commands via wrapped `sh -lc` mode when explicitly requested.
3. Keep one-tool-per-step behavior compatible with existing prompt contract.

**Step 4: Run tests**
Run: `node --test test/android-custom-tools.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat(agent): register android actions as pi custom tools"`

**Acceptance:**
1. One session can both write code and operate emulator.
2. Existing action trace logs remain readable.

**Rollback:**
Revert custom tool registration and use old runtime dispatcher.

## PR-04: Gateway Task Routing Hardening

**Files:**
- Modify: `src/gateway/chat-assistant.ts`
- Modify: `src/gateway/telegram-gateway.ts`
- Create: `test/gateway-task-routing.test.mjs`

**Step 1: Write failing routing tests**
Cases:
1. `"你可以做 X 吗"` with explicit executable output requirement routes to task.
2. Explicit capability questions remain chat.
3. `/run` remains forced task.

**Step 2: Run tests**
Run: `node --test test/gateway-task-routing.test.mjs`
Expected: FAIL.

**Step 3: Implement routing hardening**
1. Add executable-intent detector (file creation/build/run/install verbs).
2. If intent is executable and no external clarification needed, bias to task mode.
3. Keep confidence/reason logging for audit.

**Step 4: Run tests**
Run: `node --test test/gateway-task-routing.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat(gateway): harden task routing for executable intents"`

**Acceptance:**
1. Telegram asks like “可以吗” no longer silently fall back to chat when execution is clearly requested.
2. Existing chat-only QA behavior remains intact.

**Rollback:**
Revert new arbitration logic and keep prior classifier-only behavior.

## PR-05: Session and Event Unification

**Files:**
- Modify: `src/agent/session-pi-tree-jsonl-backend.ts`
- Modify: `src/agent/runtime/attempt.ts`
- Modify: `src/gateway/telegram-gateway.ts`
- Create: `test/session-event-unification.test.mjs`

**Step 1: Write failing event/persistence tests**
Validate:
1. Session events map to gateway progress updates.
2. Tool start/update/end events are persisted consistently.
3. Completion/failure entries include backend and tool metadata.

**Step 2: Run tests**
Run: `node --test test/session-event-unification.test.mjs`
Expected: FAIL.

**Step 3: Implement unified mapping**
1. Normalize pi `AgentSessionEvent` to OpenPocket progress schema.
2. Persist one consistent trace shape for both coding and Android actions.
3. Ensure session reuse loads recent messages from unified backend.

**Step 4: Run tests**
Run: `node --test test/session-event-unification.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git commit -m "refactor(session): unify pi session events with gateway progress and traces"`

**Acceptance:**
1. Dashboard/Gateway progress aligns with actual tool execution.
2. JSONL sessions remain parseable and stable.

**Rollback:**
Revert event mapping layer; keep prior append format.

## PR-06: Android Build-Install-Run-Fix Loop

**Files:**
- Create: `src/agent/android-build-loop.ts`
- Modify: `src/agent/prompts.ts`
- Modify: `src/agent/runtime/attempt.ts`
- Create: `test/android-build-loop.test.mjs`

**Step 1: Write failing loop tests**
Validate orchestrated flow:
1. Build APK.
2. Install to emulator.
3. Launch app and collect logcat + screenshot + UI tree.
4. Feed diagnostics back into code-fix iteration.

**Step 2: Run tests**
Run: `node --test test/android-build-loop.test.mjs`
Expected: FAIL.

**Step 3: Implement loop utilities**
1. Add reusable commands/helpers for Gradle build and ADB install/run.
2. Add diagnostics collector and structured error parser.
3. Wire prompt hints so the model prefers this loop for Android app-generation tasks.

**Step 4: Run tests**
Run: `node --test test/android-build-loop.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat(android): add build-install-run-fix loop for app coding tasks"`

**Acceptance:**
1. Android coding tasks can converge automatically with telemetry.
2. Failures are reported with actionable diagnostics.

**Rollback:**
Disable loop helper and fall back to manual tool chaining.

## PR-07: Tool Policy and Security Hook Alignment

**Files:**
- Create: `src/agent/tool-policy.ts`
- Modify: `src/tools/coding-executor.ts`
- Modify: `src/tools/script-executor.ts`
- Modify: `src/config/index.ts`
- Create: `test/tool-policy-hooks.test.mjs`

**Step 1: Write failing policy tests**
Validate:
1. Same allow/deny policy applies across pi coding tools, legacy executor, and script executor.
2. Sensitive env filtering is enforced for all command execution paths.
3. Workspace/symlink escape attempts are blocked.

**Step 2: Run tests**
Run: `node --test test/tool-policy-hooks.test.mjs`
Expected: FAIL.

**Step 3: Implement policy hooks**
1. Centralize command/path/env policy in one module.
2. Apply policy before executing any tool backend.
3. Add structured rejection reasons for model feedback.

**Step 4: Run tests**
Run: `node --test test/tool-policy-hooks.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat(security): centralize tool policy hooks across coding backends"`

**Acceptance:**
1. No policy drift between script/coding/android command execution.
2. Policy failures are deterministic and auditable.

**Rollback:**
Revert shared policy layer and restore per-executor validation.

## PR-08: Legacy Path Decommission and Docs

**Files:**
- Modify: `src/agent/agent-runtime.ts`
- Modify: `src/tools/coding-executor.ts`
- Modify: `openpocket.config.example.json`
- Modify: `README.md`
- Modify: `frontend/reference/config-defaults.md`
- Create: `test/legacy-coding-path-off.test.mjs`

**Step 1: Write failing decommission tests**
Validate:
1. Legacy coding executor can be disabled permanently.
2. Runtime errors clearly indicate deprecated config keys.

**Step 2: Run tests**
Run: `node --test test/legacy-coding-path-off.test.mjs`
Expected: FAIL.

**Step 3: Remove legacy default path**
1. Make pi coding path the only default.
2. Keep short deprecation window toggle with warning.
3. Update docs/config examples to new standard.

**Step 4: Run tests**
Run: `node --test test/legacy-coding-path-off.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git commit -m "chore(runtime): decommission legacy coding executor default path"`

**Acceptance:**
1. Default runtime no longer depends on legacy coding path.
2. Documentation reflects new architecture.

**Rollback:**
Restore legacy toggle default and keep migration warning.

## PR-09: End-to-End Dual-Side Smoke and Release Gate

**Files:**
- Create: `test/e2e-dual-side-smoke.test.mjs`
- Create: `scripts/smoke/dual-side-smoke.sh`
- Modify: `.github/workflows/ci.yml` (if applicable)
- Modify: `README.md` (smoke instructions)

**Step 1: Write failing E2E smoke**
Scenarios:
1. Telegram instruction creates local JS file and verifies content.
2. Android app task triggers build-install-run-diagnostics loop.
3. Session traces show consistent tool/event lineage.

**Step 2: Run tests**
Run: `node --test test/e2e-dual-side-smoke.test.mjs`
Expected: FAIL.

**Step 3: Implement smoke harness**
1. Add deterministic scripts/mocks for CI.
2. Add local command for maintainers to run smoke quickly.

**Step 4: Run full verification**
Run:
1. `npm run build`
2. `npm run check`
3. `npm test`
4. `node --test test/e2e-dual-side-smoke.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git commit -m "test(e2e): add dual-side smoke gate for pi-coding-agent adoption"`

**Acceptance:**
1. Same-task dual-side smoke is green.
2. CI has explicit gate for coding + Android path.

**Rollback:**
Keep code changes, temporarily soft-disable E2E gate if infra flakes.

## Cross-PR Release Rules

1. Each PR must include at least one happy-path and one failure-path test.
2. Each PR must publish a short rollback note in PR description.
3. Do not merge PR-08 before PR-09 smoke is green.
4. Prefer feature flags for behavior flips until PR-08.
5. After each PR merge, run:
`npm run build && npm run check && npm test`
