# OpenPocket Pi Runtime Migration (Adjusted) Implementation Plan

References: 
https://github.com/openclaw/openclaw

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## Context: Why This Plan Exists

当前 OpenPocket 已可用，但 runtime 的关键职责高度集中在单一路径（`openpocket/src/agent/agent-runtime.ts`），包括模型鉴权、system/user prompt 构建、截图生命周期、工具调用、事件订阅、会话落盘和结果收敛。这在“功能快速叠加”阶段是高效的，但在“可靠性与安全性强化”阶段会导致三个问题：

1. 变更碰撞高：同一个功能 PR 往往会同时修改执行、事件、持久化、鉴权逻辑，回归定位成本高。
2. 治理能力弱：工具策略（allow/deny/hook）与执行路径耦合，扩展新工具或增加审计点容易引入分叉行为。
3. 恢复路径不清晰：上下文溢出、鉴权失败、工具结果过大等场景缺少统一的“有界恢复链”。

对照 OpenClaw（同类 Pi 生态实现），其运行时已分层到 run/attempt、订阅桥接、tool adapter/policy、auth profile failover、context/overflow guards。OpenPocket 不需要照搬 OpenClaw，但需要引入这些“最小必要结构模式”，以降低生产风险并支撑后续能力扩展。

## Why Now

做这次迁移的时间点是“必要且可控”的，原因如下：

1. 代码规模已到分层阈值：`agent-runtime.ts` 当前超过 2k 行，继续在单文件叠加功能会放大维护风险。
2. 功能面已覆盖关键场景：已有 human-auth、memory tools、coding tools、progress narration，下一步主要矛盾从“能不能跑”转为“稳不稳、可不可以审计和恢复”。
3. 现有回归基线健康：当前 `build/check/test` 通过，适合以小步 PR 做结构化演进，而不是在不稳定基线上重构。

## Goal

在不破坏现有 `runTask()` 外部契约的前提下，把 OpenPocket 从单体 runtime 演进为可分层、可治理、可恢复的 Pi 运行时。

具体目标（必须可验收）：

1. 稳定性：新增 auth failover、context preflight、overflow recovery 后，失败路径有确定行为和明确错误。
2. 可维护性：runtime 关键职责拆到可独立测试的模块，避免后续 feature PR 反复触碰主循环大段逻辑。
3. 可治理性：工具调用进入 hook + policy + adapter 管线，阻断结果可预测且可记录。
4. 可审计性：session 持久化支持 markdown 兼容与 jsonl transcript（dual-write 可选）。
5. 安全性：命令/文件边界策略在 coding/script/apply_patch 路径上保持一致，补齐 symlink/realpath escape 防护。

## Non-Goals

1. 不进行 big-bang 重写，不在单个 PR 引入 `pi-coding-agent` 全量会话模型切换。
2. 不改变 CLI/Gateway/Cron 的调用契约和用户可见主流程。
3. 不在本计划内引入新的产品功能面（重点是运行时结构与可靠性）。

**Architecture:** 采用“先加缝隙、后加行为”的增量迁移策略。先拆运行时层和持久化层，再引入事件订阅、工具策略、认证 failover、上下文预检、溢出恢复与安全边界强化。每个 PR 必须可独立回滚，且有明确负路径测试。

**Tech Stack:** TypeScript (Node 20+), `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, Node test runner (`node --test`), OpenPocket existing runtime/tool modules.

## Baseline Snapshot (verified on 2026-02-23)

- Runtime monolith is still concentrated in `openpocket/src/agent/agent-runtime.ts`.
  - Tool build+execute loop: `openpocket/src/agent/agent-runtime.ts:1651`
  - Public run entrypoint: `openpocket/src/agent/agent-runtime.ts:2061`
- Tool metadata is centralized in `openpocket/src/agent/tools.ts:212`.
- Session persistence is markdown-only in `openpocket/src/memory/workspace.ts:284`.
- Prompt context report is already present and exposed:
  - `openpocket/src/agent/agent-runtime.ts:395`
  - `openpocket/src/agent/agent-runtime.ts:573`
  - `openpocket/src/gateway/telegram-gateway.ts:394`
- Executor security baseline exists but is inconsistent:
  - `coding-executor` has workspace guard + env redaction (`openpocket/src/tools/coding-executor.ts:123`, `openpocket/src/tools/coding-executor.ts:96`)
  - `script-executor` still uses raw `process.env` (`openpocket/src/tools/script-executor.ts:146`)

Dependency usage snapshot (repo-local scan, non-test `src`):

- openpocket: `pi-agent-core=2`, `pi-ai=3`, `pi-coding-agent=0`, `pi-tui=0`
- openclaw: `pi-agent-core=68`, `pi-ai=41`, `pi-coding-agent=27`, `pi-tui=15`

## Hard Constraints

1. Keep `runTask()` signature and result shape stable for existing callers.
   - Callers: `openpocket/src/cli.ts:289`, `openpocket/src/gateway/telegram-gateway.ts:1443`, `openpocket/src/gateway/cron-service.ts:166`
2. Every PR must include:
   - at least one happy-path test
   - at least one failure-path test
   - clear rollback note
3. No hidden coupling across PRs; each PR is deployable alone.
4. Prefer additive seams before behavior changes.

## Updated PR Sequence

## PR-00: Baseline Guard Rails (new)

**Why:** 后续 PR-04/07/08 会大量改 executor，但目前缺少 `CodingExecutor` 专项测试，先补防回归护栏。

**Files:**

- Create: `openpocket/test/coding-executor.test.mjs`
- Optional Create: `openpocket/test/coding-executor-path-escape.test.mjs`

**Change set:**

- 增加 `read/write/edit/exec/process/apply_patch` 正向测试。
- 增加 workspace escape、allowlist 拒绝、deny pattern 命中、process missing session 的负路径测试。

**Acceptance:**

1. `cd openpocket && node --test test/coding-executor.test.mjs`
2. `cd openpocket && npm test`

---

## PR-01: Runtime Layer Split (No Behavior Change)

**Why:** 先在结构上拆缝，便于后续行为改动定位回归。

**Files:**

- Create: `openpocket/src/agent/runtime/types.ts`
- Create: `openpocket/src/agent/runtime/attempt.ts`
- Create: `openpocket/src/agent/runtime/run.ts`
- Modify: `openpocket/src/agent/agent-runtime.ts`
- Test: `openpocket/test/runtime-seams.test.mjs`

**Change set:**

- 把 `runTask()` 内 orchestration 拆到 `run/attempt` 模块。
- 保持对外 `runTask()` 不变。
- 验证旧入口与新内部层返回结构一致。

**Acceptance:**

1. `cd openpocket && npm run build`
2. `cd openpocket && node --test test/runtime-seams.test.mjs`
3. `cd openpocket && npm test`

---

## PR-02: Session Backend Abstraction + Dual Write

**Why:** 让 session 持久化从 markdown-only 演进到可回放 transcript，同时保持现有兼容。

**Files:**

- Create: `openpocket/src/agent/session-backend.ts`
- Create: `openpocket/src/agent/session-markdown-backend.ts`
- Create: `openpocket/src/agent/session-jsonl-backend.ts`
- Modify: `openpocket/src/memory/workspace.ts`
- Modify: `openpocket/src/config/index.ts`
- Modify: `openpocket/src/types.ts`
- Modify: `openpocket/openpocket.config.example.json`
- Test: `openpocket/test/session-backend.test.mjs`

**Change set:**

- 引入会话存储接口（create/append/finalize）。
- 默认保持 markdown。
- 增加 dual-write 可选开关输出 `.jsonl`。

**Acceptance:**

1. `cd openpocket && node --test test/session-backend.test.mjs`
2. `cd openpocket && npm test`
3. dual-write 模式下同时产出 `sessions/*.md` 与 `sessions/*.jsonl`

---

## PR-03: Event Subscription Layer

**Why:** 让 turn/event 处理从 `runTask()` 解耦，避免输出策略改动频繁触碰主循环。

**Files:**

- Create: `openpocket/src/agent/agent-subscribe.types.ts`
- Create: `openpocket/src/agent/agent-subscribe.ts`
- Modify: `openpocket/src/agent/agent-runtime.ts`
- Test: `openpocket/test/agent-subscribe.test.mjs`

**Change set:**

- 抽离 `agent.subscribe(...)` 事件桥接逻辑。
- 规范 assistant text / tool activity / reasoning / lifecycle channel。
- 保持 `onProgress` 行为不变。

**Acceptance:**

1. `cd openpocket && node --test test/agent-subscribe.test.mjs`
2. `cd openpocket && npm test`

---

## PR-04: Tool Pipeline (Hook + Policy + Adapter)

**Why:** 显式化工具治理，减少“工具定义与执行路径”分叉风险。

**Files:**

- Create: `openpocket/src/agent/tool-hooks.ts`
- Create: `openpocket/src/agent/tool-policy.ts`
- Create: `openpocket/src/agent/tool-definition-adapter.ts`
- Modify: `openpocket/src/agent/tools.ts`
- Modify: `openpocket/src/agent/agent-runtime.ts`
- Modify: `openpocket/src/agent/model-client.ts`
- Modify: `openpocket/src/types.ts`
- Test: `openpocket/test/tool-hooks-policy.test.mjs`

**Change set:**

- 增加 `before_tool_call` / `after_tool_call` hook。
- 增加 allow/deny 与参数 guardrail。
- 把 runtime 与 model-client 的 tool definition 统一走 adapter。

**Acceptance:**

1. `cd openpocket && node --test test/tool-hooks-policy.test.mjs`
2. `cd openpocket && npm test`
3. blocked tool 返回稳定错误结构

---

## PR-05: Auth Profiles + Cooldown Rotation

**Why:** 降低单 profile 认证失败导致的整次任务失败概率。

**Files:**

- Create: `openpocket/src/agent/auth-profiles.ts`
- Create: `openpocket/src/agent/model-auth-rotation.ts`
- Modify: `openpocket/src/config/index.ts`
- Modify: `openpocket/src/agent/agent-runtime.ts`
- Optional Modify: `openpocket/src/gateway/chat-assistant.ts` (如需统一 failover 语义)
- Modify: `openpocket/src/types.ts`
- Test: `openpocket/test/auth-profile-rotation.test.mjs`

**Change set:**

- 增加 profile 组与 cooldown 元数据。
- 针对 auth/rate-limit 类错误尝试下一个 profile。
- 默认保留单 profile 行为（feature flag 关闭时）。

**Acceptance:**

1. `cd openpocket && node --test test/auth-profile-rotation.test.mjs`
2. `cd openpocket && npm test`
3. cooldown 生效，失败 profile 不会立刻重试

---

## PR-06: Context Window Preflight Guard (adjusted scope)

**Why:** 该能力当前“提示词报告”已存在，新增应聚焦“模型调用前 token 预算预检”，避免重复建设。

**Files:**

- Create: `openpocket/src/agent/context-window-guard.ts`
- Modify: `openpocket/src/agent/agent-runtime.ts`
- Modify: `openpocket/src/config/index.ts`
- Modify: `openpocket/src/types.ts`
- Test: `openpocket/test/context-window-guard.test.mjs`

**Change set:**

- 在 model call 前执行预算评估（warn/block）。
- 输出诊断复用现有 prompt report，不新增平行 report 系统。
- 配置项支持 warn/block 阈值。

**Acceptance:**

1. `cd openpocket && node --test test/context-window-guard.test.mjs`
2. `cd openpocket && npm test`
3. warn/block 阈值按配置触发

---

## PR-07: Overflow Recovery Chain

**Why:** 把 context overflow 从“硬失败”转为“有界恢复链”。

**Files:**

- Create: `openpocket/src/agent/overflow-recovery.ts`
- Create: `openpocket/src/agent/tool-result-truncation.ts`
- Modify: `openpocket/src/agent/agent-runtime.ts`
- Modify: `openpocket/src/tools/coding-executor.ts`
- Test: `openpocket/test/overflow-recovery.test.mjs`

**Change set:**

- overflow 时按顺序尝试：
  1) 轻量重试（guarded）
  2) 历史压缩/裁剪
  3) 工具结果截断
- 达到上限后返回稳定、可观测的错误。

**Acceptance:**

1. `cd openpocket && node --test test/overflow-recovery.test.mjs`
2. `cd openpocket && npm test`
3. 断言回退顺序与最大重试边界

---

## PR-08: Sandbox Boundary Hardening + Docs

**Why:** 当前已有 `workspaceOnly`，但边界策略不一致，需要统一并补齐 symlink/realpath 场景。

**Files:**

- Create: `openpocket/src/tools/sandbox-context.ts`
- Modify: `openpocket/src/tools/coding-executor.ts`
- Modify: `openpocket/src/tools/script-executor.ts`
- Modify: `openpocket/src/tools/apply-patch.ts`
- Optional Modify: `openpocket/src/dashboard/server.ts` (权限边界一致性)
- Modify: `openpocket/openpocket.config.example.json`
- Modify: `openpocket/README.md`
- Test: `openpocket/test/sandbox-exec.test.mjs`

**Change set:**

- 统一 command/file 操作边界检查策略。
- 增加 realpath/symlink escape 防护。
- `script-executor` 对齐 `coding-executor` 的环境变量安全策略。
- 文档补齐开关说明和迁移注意事项。

**Acceptance:**

1. `cd openpocket && node --test test/sandbox-exec.test.mjs`
2. `cd openpocket && npm run check`
3. `cd openpocket && npm test`
4. README + example config 覆盖新增开关

---

## Global Definition of Done

1. `cd openpocket && npm run build`
2. `cd openpocket && npm run check`
3. `cd openpocket && npm test`
4. 每个 PR 至少包含：
   - 1 个 happy-path test
   - 1 个 failure-path test
   - rollback note

## Suggested PR Titles

1. `test(runtime): add coding executor regression guard rails`
2. `refactor(agent): split runtime into run/attempt modules without behavior changes`
3. `feat(session): add pluggable session backend with markdown+jsonl dual-write`
4. `feat(agent): introduce event subscription layer for assistant/tool streams`
5. `feat(tools): add hook/policy pipeline with adapter-based tool definitions`
6. `feat(auth): add profile rotation with cooldown-based failover`
7. `feat(agent): add context-window preflight guard using existing prompt report`
8. `feat(agent): implement overflow recovery and tool-result truncation`
9. `feat(security): harden sandbox boundaries and document runtime controls`

## Execution Recommendation

- 推荐先走 **Subagent-Driven（当前会话逐 PR 检查点）**，因为本迁移跨 `agent/tools/config/memory/docs` 多层模块，逐步回归更易定位问题与回滚。
