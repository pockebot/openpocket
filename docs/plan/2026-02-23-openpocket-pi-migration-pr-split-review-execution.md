# OpenPocket Pi Runtime Migration PR Split Review + Execution Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** 在不破坏 `runTask()` 对外契约的前提下，将单体 runtime 拆分为可分层、可治理、可恢复的结构，并通过小步 PR 降低回归与生产风险。

**Architecture:** 采用“先加缝隙、后加行为”的增量迁移。优先拆层与抽象（run/attempt、subscribe、session backend、tool pipeline），再引入 auth rotation、context preflight、overflow recovery、sandbox hardening。每个 PR 可独立回滚，且包含明确的负路径测试。

**Tech Stack:** Node.js 20+、TypeScript、`@mariozechner/pi-agent-core`、`@mariozechner/pi-ai`、Node test runner（`node --test`）、现有 `src/agent`/`src/tools`/`src/config`/`src/memory` 模块。

## Input

- 评审对象：`docs/plan/2026-02-23-openpocket-pi-migration-pr-split-plan.md`
- 目标：评估合理性，并给出 Codex CLI 多 agent 的执行分工与实施计划（高效、高质量）。

## Verdict (是否合理)

整体方向**合理且可落地**，尤其是：

- 以 PR 为单位小步推进，先结构后行为，风险可控。
- 明确 Non-Goals，避免 big-bang 重写。
- 每个 PR 都要求 happy-path + failure-path 测试与回滚说明，质量门槛清晰。
- 关注点覆盖“治理（hook/policy/adapter）+ 恢复（overflow chain）+ 安全边界（realpath/symlink）”，优先级正确。

但现状有一个会直接阻塞落地的关键问题：

- 计划文档的路径与命令以 `openpocket/` 作为子目录前缀（例如 `openpocket/src/...`、`cd openpocket && ...`），而本仓库真实结构为根目录 `src/`、`test/`、`openpocket.config.example.json`。如果不修正，会导致执行期大量“文件不存在/命令无效”。

## Must-Fix (落地前必须修正)

把原计划文档中的路径/命令做一次“仓库结构对齐”。建议以“机械替换 + 少量人工校验”完成：

1. 路径前缀替换：
   - `openpocket/src/` → `src/`
   - `openpocket/test/` → `test/`
   - `openpocket/openpocket.config.example.json` → `openpocket.config.example.json`
2. 命令修正：
   - `cd openpocket && <cmd>` → 直接执行 `<cmd>`（在仓库根目录）
3. 计划文档中的 callers/行号是可选信息：
   - callers 文件名正确即可，行号可在执行时用 `rg -n` 重新定位（例如 `src/cli.ts`、`src/gateway/telegram-gateway.ts`、`src/gateway/cron-service.ts`）。

## PR 依赖与并行度评估（用于分配 agents）

现实约束：多数 PR 会改 `src/agent/agent-runtime.ts`，因此“真正意义上的并行开发”会带来高冲突率；更高效的做法是：

- 以 **“主线串行（runtime 集中改动）+ 少量并行（相对独立模块）”** 的策略推进。
- 并行优先选择“低冲突区域”的 PR：
  - `PR-02 Session backend`（主要在 `src/memory`/`src/config`/`src/types`）
  - `PR-08 Sandbox hardening`（主要在 `src/tools` + README/config）

建议并行策略（可选）：

- 串行主线：PR-00 → PR-01 → PR-03 → PR-04 → PR-05 → PR-06 → PR-07 → PR-08
- 并行支线（在 PR-01 进行时启动）：PR-02、PR-08（结束后 rebase/对齐主线）

## Agent Allocation (Codex CLI 多 agent 分工)

### 角色定义（推荐 4 个 agents）

- **Agent-Integrator（主集成/仲裁）**：负责主线 PR 串行推进与冲突解决；统一 `src/agent/agent-runtime.ts` 的结构演进；最终跑全套 `npm run build && npm run check && npm test`。
- **Agent-Runtime（运行时拆层）**：负责 PR-01、PR-03（run/attempt 与 subscribe 拆分）。
- **Agent-ToolsSecurity（工具治理与边界）**：负责 PR-00、PR-04、PR-08（coding/script/apply_patch、hook/policy/adapter、sandbox hardening + docs）。
- **Agent-Persistence（会话持久化）**：负责 PR-02（session backend + dual write）。

可选第五个（如果你希望更快）：

- **Agent-Resilience（可靠性链路）**：负责 PR-05、PR-06、PR-07（auth rotation、context preflight、overflow recovery）。如果不增加该 agent，则由 Agent-Integrator 顺序推进这三项以减少 runtime 冲突。

### 推荐分配表（默认）

| PR | Owner Agent | Reviewer Agent | 并行可行性 |
|---|---|---|---|
| PR-00 Baseline Guard Rails | ToolsSecurity | Integrator | 高 |
| PR-01 Runtime Layer Split | Runtime | Integrator | 中（与 PR-02/08 可并行） |
| PR-02 Session Backend + Dual Write | Persistence | Integrator | 高（相对独立） |
| PR-03 Event Subscription Layer | Runtime | Integrator | 低（强依赖 runtime 主线） |
| PR-04 Tool Pipeline | ToolsSecurity | Integrator | 低（触碰 runtime + model-client + tools） |
| PR-05 Auth Rotation | Integrator 或 Resilience | ToolsSecurity | 低（runtime/config） |
| PR-06 Context Preflight | Integrator 或 Resilience | Runtime | 低（runtime/config） |
| PR-07 Overflow Recovery | Integrator 或 Resilience | ToolsSecurity | 低（runtime + coding-executor） |
| PR-08 Sandbox Hardening + Docs | ToolsSecurity | Integrator | 中（与 PR-07 会有冲突风险） |

## Execution Workflow (高效/高质量实施流程)

### Option A (Recommended): Subagent-Driven 串行推进

适用于：你希望最少冲突、最稳定推进，且 `node_modules` 只维护一份。

流程：

1. 由 Agent-Integrator 在当前工作目录主控推进（每个 PR 一个分支）。
2. 每个 PR 开始前：把 PR prompt 发给对应 Owner Agent（一个 Codex CLI 会话即可；完成后交回 Integrator）。
3. Owner Agent 完成：
   - 跑该 PR 的 targeted test（`node --test test/<name>.test.mjs`）
   - 跑全量（`npm test`，必要时加 `npm run check`）
   - 给出“变更摘要 + 风险点 + 回滚要点”
4. Integrator 复核并做最终合入前验证：
   - `npm run build && npm run check && npm test`

### Option B: Git Worktrees 小规模并行（PR-02/08 并行）

适用于：你有 3-4 个终端/会话，愿意承担 rebase 成本换取更快交付。

建议命名（示例）：

- `worktrees/pi-mig-main`：主线（PR-00/01/03/04/05/06/07）
- `worktrees/pi-mig-session`：PR-02
- `worktrees/pi-mig-sandbox`：PR-08

关键纪律：

- 不并行修改 `src/agent/agent-runtime.ts`（或尽量减少），否则冲突成本会抵消收益。
- PR-08 若需要改动与 PR-07 同文件（例如 `src/tools/coding-executor.ts`），务必在集成阶段 rebase 并再跑全测。

## Per-PR Codex CLI Prompt Templates (可直接复制给 agent)

> 下面 prompts 已按本仓库真实路径修正（`src/`、`test/` 在根目录）。

### PR-00: Baseline Guard Rails

目标：为 `CodingExecutor` 增加回归护栏测试（正向 + 负向），不改变生产行为。

范围：

- Create: `test/coding-executor.test.mjs`
- Optional Create: `test/coding-executor-path-escape.test.mjs`

验收：

- `node --test test/coding-executor.test.mjs`
- `npm test`

约束：

- 不要通过“加大 timeout”逃避真实问题；测试要可重复、无竞态。
- 负路径至少覆盖：workspace escape、allowlist 拒绝、deny pattern 命中、process missing session。

输出：

- 简要说明新增测试覆盖了哪些关键风险点。

### PR-01: Runtime Layer Split (No Behavior Change)

目标：在不改变 `runTask()` 行为与返回 shape 的前提下，把 orchestration 拆到 `src/agent/runtime/*`。

范围：

- Create: `src/agent/runtime/types.ts`
- Create: `src/agent/runtime/attempt.ts`
- Create: `src/agent/runtime/run.ts`
- Modify: `src/agent/agent-runtime.ts`
- Test: `test/runtime-seams.test.mjs`

验收：

- `npm run build`
- `node --test test/runtime-seams.test.mjs`
- `npm test`

约束：

- 不引入新配置项、不调整日志/错误文案（除非测试证明必须）。

输出：

- 说明拆分边界（run vs attempt）以及如何确保对外契约不变。

### PR-02: Session Backend Abstraction + Dual Write

目标：把 session 写入从 markdown-only 抽象为 backend；默认仍写 markdown，并在开关开启时 dual-write `.jsonl` transcript。

范围：

- Create: `src/agent/session-backend.ts`
- Create: `src/agent/session-markdown-backend.ts`
- Create: `src/agent/session-jsonl-backend.ts`
- Modify: `src/memory/workspace.ts`
- Modify: `src/config/index.ts`
- Modify: `src/types.ts`
- Modify: `openpocket.config.example.json`
- Test: `test/session-backend.test.mjs`

验收：

- `node --test test/session-backend.test.mjs`
- `npm test`
- dual-write 开启时确实产出 `.md` 与 `.jsonl`

约束：

- 默认行为不变（不开启 dual-write 不新增文件）。

输出：

- 简述 backend 接口（create/append/finalize）和 dual-write 的兼容策略。

### PR-03: Event Subscription Layer

目标：把 `agent.subscribe(...)` 的事件桥接/进度叙述从 runtime 主循环解耦，保持 `onProgress` 语义不变。

范围：

- Create: `src/agent/agent-subscribe.types.ts`
- Create: `src/agent/agent-subscribe.ts`
- Modify: `src/agent/agent-runtime.ts`
- Test: `test/agent-subscribe.test.mjs`

验收：

- `node --test test/agent-subscribe.test.mjs`
- `npm test`

输出：

- 说明 subscribe 的职责边界和事件分类（assistant text / tool activity / lifecycle）。

### PR-04: Tool Pipeline (Hook + Policy + Adapter)

目标：工具调用统一进入 hook + policy + adapter 管线；blocked tool 返回稳定错误结构且可记录。

范围：

- Create: `src/agent/tool-hooks.ts`
- Create: `src/agent/tool-policy.ts`
- Create: `src/agent/tool-definition-adapter.ts`
- Modify: `src/agent/tools.ts`
- Modify: `src/agent/agent-runtime.ts`
- Modify: `src/agent/model-client.ts`
- Modify: `src/types.ts`
- Test: `test/tool-hooks-policy.test.mjs`

验收：

- `node --test test/tool-hooks-policy.test.mjs`
- `npm test`

约束：

- 避免在一个 PR 里同时改“工具定义 schema + 工具执行语义”，优先把管线接入做成“结构性变化”。

输出：

- 给出 blocked tool 的错误 shape（字段名、稳定性承诺）。

### PR-05: Auth Profiles + Cooldown Rotation

目标：对 auth/rate-limit 类错误引入 profile rotation + cooldown，默认保持单 profile 行为（开关关闭）。

范围：

- Create: `src/agent/auth-profiles.ts`
- Create: `src/agent/model-auth-rotation.ts`
- Modify: `src/config/index.ts`
- Modify: `src/agent/agent-runtime.ts`
- Optional Modify: `src/gateway/chat-assistant.ts`
- Modify: `src/types.ts`
- Test: `test/auth-profile-rotation.test.mjs`

验收：

- `node --test test/auth-profile-rotation.test.mjs`
- `npm test`

输出：

- 说明错误分类规则与 cooldown 的可测试实现方式（可注入 clock/时间源）。

### PR-06: Context Window Preflight Guard

目标：在 model call 前做 token 预算预检（warn/block），诊断复用现有 prompt report。

范围：

- Create: `src/agent/context-window-guard.ts`
- Modify: `src/agent/agent-runtime.ts`
- Modify: `src/config/index.ts`
- Modify: `src/types.ts`
- Test: `test/context-window-guard.test.mjs`

验收：

- `node --test test/context-window-guard.test.mjs`
- `npm test`

输出：

- 说明预算评估的输入（messages/system/user/tools）与阈值配置。

### PR-07: Overflow Recovery Chain

目标：把 overflow 从硬失败变为有界恢复链：轻量重试 → 历史压缩/裁剪 → 工具结果截断，超限后返回稳定错误。

范围：

- Create: `src/agent/overflow-recovery.ts`
- Create: `src/agent/tool-result-truncation.ts`
- Modify: `src/agent/agent-runtime.ts`
- Modify: `src/tools/coding-executor.ts`
- Test: `test/overflow-recovery.test.mjs`

验收：

- `node --test test/overflow-recovery.test.mjs`
- `npm test`

约束：

- 明确最大重试次数与顺序，测试必须断言顺序与边界。

输出：

- 说明截断标记策略（例如在结果末尾追加 `...(truncated)` 之类的稳定 marker）。

### PR-08: Sandbox Boundary Hardening + Docs

目标：统一 coding/script/apply_patch 的边界检查策略，补齐 realpath/symlink escape；更新 README 与 example config。

范围：

- Create: `src/tools/sandbox-context.ts`
- Modify: `src/tools/coding-executor.ts`
- Modify: `src/tools/script-executor.ts`
- Modify: `src/tools/apply-patch.ts`
- Optional Modify: `src/dashboard/server.ts`
- Modify: `openpocket.config.example.json`
- Modify: `README.md`
- Test: `test/sandbox-exec.test.mjs`

验收：

- `node --test test/sandbox-exec.test.mjs`
- `npm run check`
- `npm test`

输出：

- 给出“边界策略的一致性说明”（允许/拒绝规则、realpath 处理、与 `workspaceOnly` 的关系）。

## Global Definition of Done (每个 PR 合入前)

- `npm run build`
- `npm run check`
- `npm test`
- PR 描述必须包含：
  - 至少 1 个 happy-path 测试说明
  - 至少 1 个 failure-path 测试说明
  - rollback note（如何回滚、风险点）

## Notes (增强质量但不扩大范围)

1. 建议在 PR-01 或 PR-03 增加一个轻量“`runTask()` 契约快照测试”（只验证返回 shape 与关键字段存在性，不校验不稳定文本），用来卡住“无意的对外破坏”。
2. PR-05/06/07 属于“可靠性链路”，建议均以 feature flag 默认关闭或默认 warn-only（取决于当前产品策略），避免一次上线改变太多失败语义。
3. PR-08 的 realpath/symlink 测试要兼容 macOS/Linux（CI 环境），避免依赖平台特性。

