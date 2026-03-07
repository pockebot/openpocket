# Multi-Agent Setup

OpenPocket supports **multiple isolated agent instances** inside one `OPENPOCKET_HOME`.

Each install always starts with one **default agent**:

- config: `OPENPOCKET_HOME/config.json`
- workspace: `OPENPOCKET_HOME/workspace/`
- state: `OPENPOCKET_HOME/state/`

You can then create more agents with their own isolated storage and targets.

## Why Multi-Agent Exists

Multi-agent support is not just a convenience feature. It changes what OpenPocket can be used for in practice.

Many real deployments do not want:

- one agent
- one phone
- one linear workflow

They want a **local phone squad**:

- one computer at home or in a small office
- multiple Android phones or emulators connected to it
- multiple isolated agents operating those phones in parallel
- one place to manage targets, configs, runtime state, and human-auth entry points

This is the practical reason OpenPocket supports multi-agent instances instead of forcing one agent to juggle many targets.

## Practical Use Cases

### 1) Home lab: many Android phones on one computer

You can set up several Android phones at home, connect them to one Mac or PC, and create one agent per phone:

```bash
openpocket onboard
openpocket create agent social-us --type physical-phone --device R5CX123456A
openpocket create agent social-eu --type physical-phone --device R5CX123456B
openpocket create agent ops-bot --type emulator
openpocket agents list
```

This gives you one control plane for many isolated phone workers without needing a hosted cloud phone service.

### 2) Build your own Agent Phone squad

Multiple agents can run at the same time, each controlling its own phone:

- one agent handles social posting
- one agent handles customer replies
- one agent monitors leads, shops, or account state
- one agent stays on an emulator for testing or recovery flows

Instead of one overloaded assistant, you get a small **squad** of isolated phone operators.

### 3) Real-world operations

Examples of realistic workloads:

- social media operations across separate accounts or regions
- lead intake and response workflows
- commerce or marketplace workflows
- utility/payment/account maintenance flows
- repeated “phone-native” work that would otherwise need manual tapping every day

The important point is not the specific niche. The important point is that many consumer and small-business workflows are still trapped inside phone apps, and multi-agent OpenPocket lets users build their own local execution layer for those apps.

## Why This Matters as Open Source

A lot of startups are effectively packaging some version of:

- managed phone fleets
- task automation on mobile apps
- human-in-the-loop approval
- operations dashboards around those phone workers

OpenPocket takes the same underlying idea and makes it locally deployable.

That matters because it lowers the barrier for:

- individual builders
- small teams
- home operators
- researchers and hackers

With multi-agent support, users can assemble a local “phone airport” or “phone farm” on their own hardware, with their own targets, their own data boundary, and their own operational rules.

That is the deeper reason for this feature: not just running one clever phone agent, but giving people the ability to build their own programmable phone workforce.

## What Isolation Means

Each managed agent gets its own:

- `config.json`
- `workspace/`
- `state/`
- task/session/memory history
- screenshots
- channel credentials and channel state
- dashboard
- gateway process
- target binding

OpenPocket does **not** share these between agents.

What is shared at the install level:

- agent registry
- manager dashboard
- port allocation
- target exclusivity locks
- optional shared human-auth relay hub / ngrok public URL

## Default Agent vs Managed Agents

After `openpocket onboard`, the root config/workspace/state acts as the `default` agent.

Managed agents live under:

```text
~/.openpocket/agents/<agentId>/
  config.json
  workspace/
  state/
```

The manager metadata lives under:

```text
~/.openpocket/manager/
  registry.json
  model-template.json
  ports.json
  locks/
```

## Create an Agent

Example:

```bash
openpocket create agent review-bot --type physical-phone --device R5CX123456A
```

This command:

1. validates the agent id
2. creates `agents/<agentId>/config.json`
3. creates a new isolated workspace and state directory
4. copies the **initial model template** captured during onboard
5. clears target-specific runtime identity (`agent.deviceId`, `target.adbEndpoint`)
6. clears channel credentials and keeps only `channels.defaults`
7. allocates a new dashboard port
8. binds the new agent to the requested target
9. registers the new agent in `manager/registry.json`

Important behavior:

- new agents do **not** copy old workspace memories, sessions, scripts, or skills
- new agents do **not** copy channel tokens or auth state
- model config is copied **once** from the manager template, then becomes independent per agent

## Agent Management Commands

```bash
openpocket agents list
openpocket agents show [<id>]
openpocket agents delete <id>
```

Examples:

```bash
openpocket agents list
openpocket agents show review-bot
openpocket agents delete review-bot
```

Notes:

- `default` cannot be deleted
- `agents delete` requires the target agent gateway to be stopped first
- `agents show` defaults to `default` when no id is provided

## Use `--agent` on Existing CLI Commands

Most existing CLI commands are now agent-aware:

```bash
openpocket --agent review-bot config-show
openpocket --agent review-bot model show
openpocket --agent review-bot target show
openpocket --agent review-bot target set --type physical-phone --device R5CX123456A
openpocket --agent review-bot gateway start
openpocket --agent review-bot dashboard start
openpocket --agent review-bot agent "Open Instagram and post the latest image"
openpocket --agent review-bot channels login --channel discord
```

Rules:

- `--config <path>` and `--agent <id>` are mutually exclusive
- omitting both means `default`
- every agent keeps its own target, channels, and workspace

## One Target Per Agent

OpenPocket does **not** run one agent across multiple targets.

The runtime model is:

- one agent instance
- one selected target at a time
- one isolated workspace/state per agent

If you need a second target, create a second agent instead of overloading one agent.

Target binding is exclusive:

- `create agent` rejects a target already bound to another agent
- `target set` also re-checks exclusivity before saving
- gateway startup acquires a runtime target lock, so two running gateways cannot claim the same target

## Model Configuration Behavior

Managed agents do not live-share model config.

Instead:

1. onboard captures an initial `manager/model-template.json`
2. `create agent` copies that template into the new agent config
3. after creation, each agent can change `defaultModel` and `models.*` independently

Example:

```bash
openpocket model set --name gpt-5.4
openpocket --agent review-bot model set --provider google --model gemini-3.1-pro-preview
openpocket --agent review-bot model show
```

## Dashboard Model

There are now two dashboard layers.

### Per-agent dashboard

```bash
openpocket --agent review-bot dashboard start
```

This dashboard is scoped to one agent instance only.

### Manager dashboard

```bash
openpocket dashboard manager
```

This dashboard shows:

- all registered agents
- config/workspace/state paths
- default model
- target fingerprint
- configured channel types
- gateway running status and PID
- link to each per-agent dashboard

## Shared Human-Auth Relay Hub

If you use multiple managed agents and only want **one** relay/ngrok entry, start the shared relay hub:

```bash
openpocket human-auth-relay start
```

Behavior:

- every managed agent still runs its own private local relay
- the shared hub proxies requests by `agentId`
- one ngrok public URL can serve all agents
- public links are namespaced as `/a/<agentId>/...`
- request state and uploaded artifacts still remain inside each agent's `state/`

If the hub is unavailable, a managed agent falls back to its direct local relay URL.

## Recommended Operational Pattern

Example install with three isolated agents:

```bash
openpocket onboard
openpocket create agent review-bot --type physical-phone --device R5CX123456A
openpocket create agent ops-bot --type emulator
openpocket agents list
openpocket human-auth-relay start
openpocket gateway start
openpocket --agent review-bot gateway start
openpocket --agent ops-bot gateway start
openpocket dashboard manager
```

Suggested usage:

- keep `default` on an emulator for general testing
- bind real-device workflows to named managed agents
- dedicate channels per agent when possible
- if multiple agents share the same group chat, configure per-channel mention/allowlist policy carefully so they do not all answer the same message
- think in terms of roles: one phone/agent for growth, one for ops, one for experiments, one for recovery

## Related Pages

- [Quickstart](./quickstart.md)
- [Device Targets](./device-targets.md)
- [Configuration](./configuration.md)
- [CLI and Gateway Reference](../reference/cli-and-gateway.md)
- [Filesystem Layout](../reference/filesystem-layout.md)
- [Recommended Multi-Agent Deployment Patterns](../ops/multi-agent-deployment-patterns.md)
