# OpenPocket Documentation

This documentation is organized into documentation hubs with a clear separation of onboarding, concepts, tooling, reference, and operations:

- Start with task-oriented onboarding.
- Move to concepts and execution model.
- Use tools/reference pages for exact schemas and defaults.
- Keep operations and troubleshooting separated.

All pages in this folder document implemented behavior in the current TypeScript runtime (`src/`).
The primary control surface is the local Web dashboard (`openpocket dashboard start` or auto-started by `gateway start`).

## Direction

OpenPocket is a local device-first phone-use agent aimed at real consumer scenarios, not only developer workflows.

- local execution on configurable Agent Phone targets (`emulator` default, `physical-phone` ready)
- no mandatory cloud-hosted phone runtime
- local data and permission boundary by default
- dual control model: direct human control + agent control
- remote human-auth approvals from Human Phone (one-time web link + Telegram fallback)
- capability-probe + agentic delegation for sensitive data flows

## Doc Hubs

| Hub | Purpose | Entry |
| --- | --- | --- |
| Get Started | Install, initialize, and configure quickly | [Quickstart](./get-started/quickstart.md) |
| Concepts | Understand blueprint, architecture, and core agent mechanics | [Project Blueprint](./concepts/project-blueprint.md) |
| Tools | Skill and script authoring and runtime behavior | [Skills](./tools/skills.md) |
| Reference | Precise schemas, defaults, formats, and commands | [Config Defaults](./reference/config-defaults.md) |
| Ops | Day-2 runbook and troubleshooting | [Runbook](./ops/runbook.md) |

## Popular Specs

- Product blueprint: [Project Blueprint](./concepts/project-blueprint.md)
- Prompt templates: [Prompt Templates](./reference/prompt-templates.md)
- Default values: [Config Defaults](./reference/config-defaults.md)
- Session and memory formats: [Session and Memory Formats](./reference/session-memory-formats.md)
- Skill format and loading rules: [Skills](./tools/skills.md)
- Script format and execution rules: [Scripts](./tools/scripts.md)
- CLI and Telegram commands: [CLI and Gateway](./reference/cli-and-gateway.md)
- Remote auth and delegation design: [Remote Human Authorization](./concepts/remote-human-authorization.md)

## Scope Policy

- Document implemented behavior first, and clearly mark roadmap items as planned.
- Mark fallback behavior and normalization rules explicitly.
- Keep examples executable with current CLI.
