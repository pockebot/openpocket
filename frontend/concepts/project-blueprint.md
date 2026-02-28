# Project Blueprint

This page describes the product direction of OpenPocket as a **consumer-ready phone-use agent** built around a local, configurable Agent Phone runtime.

## Product Vision

OpenPocket helps everyday users complete real mobile tasks with an AI agent, while keeping control and sensitive data on their own machine.

The target is not only developer productivity. The core focus is everyday life scenarios such as:

- shopping
- entertainment
- social and messaging workflows
- repetitive in-app routines

## Core Principles

### Local Agent Phone Runtime

OpenPocket executes locally through `adb`, but the controlled target is configurable:

- `emulator` (default)
- `physical-phone` (USB/Wi-Fi ADB, ready)
- `android-tv` (in progress)
- `cloud` (in progress)

Why this matters:

- users can start quickly with emulator
- users can switch to a dedicated physical Android phone for production-like behavior
- no mandatory hosted cloud phone runtime

### Human Phone vs Agent Phone

OpenPocket uses a strict two-device model:

- **Agent Phone**: the controlled execution target (emulator or connected device), treated as clean runtime surface
- **Human Phone**: the user’s personal phone, used only for approvals and delegated personal data through Human Auth

This separation reduces accidental leakage from personal daily-use devices into automation runtime.

### Local Data + Auditability

OpenPocket is not a cloud execution farm.

- device automation runs locally through `adb`
- workspace artifacts remain local (`sessions`, `memory`, `scripts`, screenshots)
- model calls are explicit and configurable; users choose model provider and endpoint
- human-auth relay state and uploaded artifacts are locally inspectable

### Dual Control

OpenPocket is designed for both autonomous and manual interaction:

- **Direct control**: users can operate the current Agent Phone target themselves
- **Agent control**: the agent can operate the same target through planned actions

This enables practical handoff between human and agent in one runtime.

### Human-in-the-Loop

OpenPocket should always allow users to intervene, inspect, and continue.

Current foundations:

- observable task lifecycle
- step-by-step persistence and logs
- explicit command surfaces (`agent`, `gateway`, `emulator`, `script`, `target`)
- remote auth unblock flow via one-time web approval link and Telegram `/auth` fallback
- agentic delegation: runtime stores/describes artifacts, and the agent decides how to apply them

Near-term roadmap:

- richer target-specific hardening (physical phone first)
- broader Android TV/cloud deployment completion
- deeper checkpoint UX for long-running real-world tasks

## Experience Layers

1. **Runtime Layer**: local target runtime (`adb`) + task loop + persistence.
2. **Control Layer**: CLI, Telegram gateway, and web dashboard.
3. **Trust Layer**: local storage, auditable sessions, script guardrails, controlled execution.
4. **Collaboration Layer**: human and agent share control through execution + approval boundaries.

## User Scenarios

### Shopping

- compare products across multiple apps
- prepare carts and checkouts with user confirmation before final purchase

### Entertainment

- routine content checks, sign-ins, and navigation between media apps
- repeated daily engagement flows without manual repetition

### Social

- draft-assist and interaction setup in social apps
- structured review before sending or posting

## Non-Goals

- not a browser-only desktop automation tool
- not limited to coding and office productivity tasks
- not a centralized cloud phone execution service

## Summary

OpenPocket is evolving into a practical personal phone-use system: local, controllable, auditable, target-configurable, and oriented toward real consumer app workflows.
