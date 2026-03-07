# Recommended Multi-Agent Deployment Patterns

This page focuses on **practical deployment patterns** for OpenPocket multi-agent installs.

The goal is not to describe abstract architecture. The goal is to help you assemble a stable, useful multi-agent setup on real hardware.

OpenPocket is a neutral open-source framework. Use these patterns for lawful, policy-compliant development, testing, operations, and personal productivity workflows.

## First Principle

OpenPocket's current multi-agent model is:

- one install
- many isolated agents
- one target per agent
- one workspace/state per agent
- one gateway/dashboard per agent

This means the recommended operating style is:

- assign each agent a role
- assign each agent a target it owns
- assign each agent its own channel or tightly scoped audience when possible
- think in terms of **parallel independent workers**, not one giant orchestrator

## Pattern 1: Solo Home Lab Starter Setup

Best for:

- one builder at home
- one computer
- one or two real Android phones
- one emulator for testing

Suggested layout:

| Agent | Target | Role |
| --- | --- | --- |
| `default` | emulator | sandbox, prompt iteration, dry runs |
| `social-bot` | real phone A | content publishing / communication workflows |
| `ops-bot` | real phone B | account checks, app maintenance, daily operations |

Suggested commands:

```bash
openpocket onboard
openpocket create agent social-bot --type physical-phone --device R5CX123456A
openpocket create agent ops-bot --type physical-phone --device R5CX123456B
openpocket agents list
openpocket human-auth-relay start
openpocket gateway start
openpocket --agent social-bot gateway start
openpocket --agent ops-bot gateway start
openpocket dashboard manager
```

Why this works:

- the emulator absorbs experimentation and breakage
- real devices stay focused on production-like work
- one manager dashboard gives you visibility without merging state

## Pattern 2: Sandbox + Production Ring

Best for:

- people who need reliability on real accounts
- app flows that can break after UI changes
- any workflow where experimentation should not happen on the production phone

Suggested layout:

| Ring | Target Type | Purpose |
| --- | --- | --- |
| Sandbox ring | emulator agents | try prompts, debug skills, rehearse flows |
| Production ring | physical-phone agents | real account execution |

Guidance:

- never test a brand-new workflow directly on the production agent
- rehearse the steps on an emulator agent first
- once the flow is stable, run it on the production agent bound to the real phone
- keep production workspaces cleaner and more predictable than sandbox workspaces

This is the easiest way to reduce accidental account damage.

## Pattern 3: Role-Based Agents

Best for:

- content operations
- customer support
- repeated operational work
- small business workflows

A good setup often looks like this:

| Agent | Role |
| --- | --- |
| `growth-bot` | publishing, scheduling, content tasks |
| `inbox-bot` | replies, inbox triage, customer follow-up |
| `ops-bot` | account maintenance, app checks, daily operations |
| `lab-bot` | experiments, regression checks, recovery drills |

This pattern is stronger than “one smart generalist agent” because:

- prompt context stays narrower
- channel routing is cleaner
- target ownership is clearer
- session/memory history stays closer to one operational domain

## Pattern 4: Region or Account Isolation

Best for:

- region-based operations
- account separation
- different risk profiles
- different app/account identities that should not share memory or channel state

Suggested naming:

- `social-us`
- `social-eu`
- `ops-main`
- `ops-backup`
- `marketplace-a`
- `marketplace-b`

Why isolate this way:

- each agent keeps its own workspace memory and task history
- each agent can have different channels and credentials
- each agent can use a different model profile if needed
- mistakes stay localized

This pattern is especially useful when one machine is managing several phones for several business lanes.

## Pattern 5: Mixed Target Ladder

Best for:

- teams that want cheap iteration plus real-device execution
- workflows that are mostly UI-stable but still need physical-device confirmation

Recommended split:

| Layer | Target | What it does |
| --- | --- | --- |
| cheap iteration | emulator agents | UI rehearsal, prompt iteration, skill tuning |
| real execution | physical-phone agents | final production runs |

Important clarification:

This is an **operational pattern**, not an automatic orchestrator.

OpenPocket today does not automatically split one task across these agents. Instead, you operate them as separate role-based runtimes.

That still provides real value:

- emulator agents discover breakage early
- real-device agents stay reserved for higher-confidence work
- you reduce the time real phones spend on trial-and-error loops

## Pattern 6: Shared Human-Auth Control Plane

Best for:

- many managed agents
- one free ngrok tunnel
- one operator phone approving actions across the whole setup

Recommended setup:

```bash
openpocket human-auth-relay start
openpocket dashboard manager
```

Why this matters:

- all managed agents can share one public relay entry
- requests are namespaced by `agentId`
- artifacts and request state still remain isolated per agent
- the operator only needs one approval surface instead of one public relay per agent

This is the cleanest way to run a multi-agent setup from home when public relay resources are limited.

## Pattern 7: Business and Operations Stack

Best for:

- small teams with repeated app-native workflows
- builders who want multiple app-based workflows running in parallel

Typical categories:

- social media operations
- customer support and response loops
- listing or account maintenance workflows
- repetitive approval or check workflows
- region/account-separated app operations

The point is not “one magic app.”
The point is that many valuable workflows still live inside mobile apps, and OpenPocket lets users build their own local execution layer around those apps.

This is why multi-agent matters strategically: it turns OpenPocket from a single assistant into a more practical local platform for several isolated workflows.

## Channel Topology Recommendations

### Best: one primary channel per agent

Examples:

- one Telegram bot/chat per agent
- one Discord surface per agent
- one WhatsApp surface per agent

This keeps routing obvious.

### Acceptable: many agents in one group

If you put many agents in the same group:

- configure mention policy carefully
- configure allowlists carefully
- avoid “everyone answers everything” setups
- use agent naming that is obvious to humans

Otherwise you create noisy collisions and operator confusion.

## Model Allocation Recommendations

Different agents do not need the same model.

A practical split:

- cheap/faster model on bulk or repetitive agents
- better reasoning model on high-value or fragile workflows
- emulator lab agents can usually tolerate more experimentation
- production agents should prefer predictability over novelty

Example:

```bash
openpocket model set --name gpt-5.4
openpocket --agent growth-bot model set --provider google --model gemini-3.1-pro-preview
openpocket --agent lab-bot model set --provider openai --model gpt-5.2-codex
```

## Hardware and Network Guidance

### Real phones

Recommended:

- powered USB hub if running several phones
- stable cables and labeled ports
- phone stands / cooling if devices stay on for long sessions
- keep Developer Options and USB debugging stable

### Emulators

Recommended:

- one AVD per emulator-backed agent
- avoid sharing one AVD between agents
- watch RAM/CPU pressure as emulator count grows

### Network

Recommended:

- prefer USB for the most critical phones
- use Wi-Fi ADB for convenience, not for your most fragile workflows
- keep relay hub and manager dashboard ports documented

## Naming Conventions That Scale

Use names that reflect role and target purpose:

- `default`
- `lab-bot`
- `growth-bot`
- `inbox-bot`
- `ops-bot`
- `social-us`
- `social-eu`
- `market-a`
- `market-b`

Avoid vague names like:

- `test1`
- `phone2`
- `newbot`

Clear naming makes `agents list`, dashboard views, and incident response much easier.

## Anti-Patterns

### 1) One agent for many phones

Do not try to overload one agent with many targets.
That is explicitly not the runtime model.

### 2) One shared group chat with loose access rules

This usually creates duplicate replies and operator confusion.

### 3) Production-only deployment with no sandbox agent

You will end up debugging on the real device.
That is expensive and risky.

### 4) Reusing the same target for multiple agents

OpenPocket prevents this for good reason.
Target ownership must stay exclusive.

### 5) Copying workspaces around casually

Workspaces hold:

- session history
- daily memory
- identity/profile files
- generated skills/scripts

Blind copying destroys the operational meaning of isolation.

## What a Good Home Deployment Looks Like

A strong small-scale setup often looks like this:

- one always-available computer
- one default emulator agent for experiments
- two to five real phone agents with clear roles
- one manager dashboard always reachable locally
- one shared relay hub for approvals
- one naming convention for agents, targets, and channels
- one habit of testing on emulator before touching production phones

That is enough to build a real local multi-agent environment.

## Related Pages

- [Multi-Agent Setup](../get-started/multi-agent.md)
- [Runbook](./runbook.md)
- [Troubleshooting](./troubleshooting.md)
- [CLI and Gateway Reference](../reference/cli-and-gateway.md)
- [Remote Human Authorization](../concepts/remote-human-authorization.md)
