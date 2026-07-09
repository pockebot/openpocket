# Codex Plugin and Claude Code MCP Integration

This document describes the OpenPocket integration layer for Codex and Claude Code. It is separate from the main OpenPocket runtime: the runtime owns Android target control, while the Codex plugin and Claude Code MCP registration expose that control surface to coding agents.

## What Lives Where

| Path | Purpose |
| --- | --- |
| `plugins/openpocket-phone/` | Codex plugin bundle. This is the installable local plugin package. |
| `plugins/openpocket-phone/.codex-plugin/plugin.json` | Codex plugin manifest, UI metadata, skill path, and MCP config path. |
| `plugins/openpocket-phone/.mcp.json` | MCP registration used by the Codex plugin. It launches the wrapper script from the plugin cache. |
| `plugins/openpocket-phone/skills/phone-use/SKILL.md` | Codex skill instructions for phone-use safety, tool selection, and interaction loops. |
| `plugins/openpocket-phone/scripts/openpocket-phone-mcp.mjs` | Codex plugin wrapper that locates `dist/mcp/server.js` from the source repo, plugin cache, or environment. |
| `plugins/openpocket-phone/scripts/doctor.mjs` | Local preflight that verifies the plugin manifest, MCP server path, and required tool surface. |
| `plugins/openpocket-phone/README.md` | User-facing install guide for Codex CLI, Codex Desktop App, Claude Code CLI, Claude Code Desktop App, and Claude Desktop MCP. |
| `src/mcp/server.ts` | The actual OpenPocket Phone MCP server implementation. Codex and Claude Code both ultimately use this server. |
| `.mcp.json` | Project-scoped MCP config for Claude Code when opened from the repository root. |

The Codex plugin is therefore a bundle of:

- a Codex plugin manifest
- one Codex skill
- a stdio MCP server registration
- helper scripts for server discovery and diagnostics

Claude Code does not use the Codex plugin manifest or skill. It uses the MCP server directly through `.mcp.json` or `claude mcp add`.

## Prerequisites

```bash
npm install
npm run build
```

You also need:

- Node.js 20 or newer
- Android SDK platform-tools and emulator tools
- an OpenPocket target configured in `openpocket.config.json`
- an emulator AVD or an authorized Android device

For an emulator target:

```bash
openpocket target set --type emulator
openpocket emulator start
```

For a physical phone:

```bash
adb devices -l
openpocket target set --type physical-phone --device <serial>
```

For Wi-Fi ADB pairing:

```bash
openpocket target pair \
  --host <device-ip> \
  --pair-port <pair-port> \
  --code <pairing-code> \
  --type physical-phone
```

## Codex Setup

For the most user-friendly install matrix, including Codex CLI and Codex Desktop App, see [`plugins/openpocket-phone/README.md`](../plugins/openpocket-phone/README.md).

Install the local marketplace and plugin from the OpenPocket repository root:

```bash
npm install
npm run build
codex plugin marketplace add /path/to/openpocket
codex plugin add openpocket-phone@openpocket-local
```

Then start a fresh Codex thread or fresh `codex exec` session. Existing desktop threads may not pick up newly installed local MCP tools until a new session is created.

Run the plugin preflight without touching a phone target:

```bash
node plugins/openpocket-phone/scripts/doctor.mjs
```

The output should report:

- `pluginName: "openpocket-phone"`
- `mcpServerName: "openpocket-phone"`
- `toolCount: 23`
- required tools including `ui_snapshot`, `visible_text`, `find_text`, `wait_for_text`, `tap_text`, `open_app`, and `list_apps`

### Codex Validation Prompt

Use a fresh Codex session and ask it to use only native OpenPocket tools:

```text
Use the openpocket-phone plugin only. Call target_status and report targetType,
avdName, devices, bootedDevices, resolvedDeviceId, resolveError, and
ambiguousTarget. Then confirm whether ui_snapshot, visible_text, find_text,
wait_for_text, tap_text, open_app, and list_apps are visible.
```

A successful run proves that Codex has loaded the plugin-provided MCP tools natively for that session.

## Claude Code Setup

For the most user-friendly install matrix, including Claude Code CLI, Claude Code Desktop App, and Claude Desktop MCP configuration, see [`plugins/openpocket-phone/README.md`](../plugins/openpocket-phone/README.md).

### Option 1: Project-Scoped MCP

Build OpenPocket, then open Claude Code from the repository root:

```bash
npm install
npm run build
claude
```

The root `.mcp.json` registers:

```json
{
  "mcpServers": {
    "openpocket-phone": {
      "command": "node",
      "args": ["dist/mcp/server.js"]
    }
  }
}
```

Inside Claude Code, run:

```text
/mcp
```

You should see `openpocket-phone` with 23 tools.

### Option 2: Manual MCP Registration

Register the server explicitly:

```bash
claude mcp add --transport stdio openpocket-phone -- \
  node /path/to/openpocket/dist/mcp/server.js
```

With a custom config path:

```bash
claude mcp add --transport stdio openpocket-phone -- \
  node /path/to/openpocket/dist/mcp/server.js \
  --config /path/to/openpocket.config.json
```

## Tool Surface

| Tool | Use |
| --- | --- |
| `target_status` | Inspect target type, online devices, booted devices, and ambiguity. |
| `start_emulator` | Start the configured emulator target. |
| `stop_emulator` | Stop the configured emulator target. |
| `current_app` | Inspect foreground app and screenshot hash without image payloads. |
| `screenshot` | Capture image content with UI metadata, visible text, secure-surface status, and metrics. |
| `ui_snapshot` | Capture text-only UI metadata without image payloads. |
| `visible_text` | Return visible/accessibility text and source element IDs. |
| `find_text` | Find elements by text, content description, resource ID, or class name. |
| `wait_for_text` | Poll until matching UI text appears. |
| `tap_text` | Tap the best matching element by visible text or resource ID. |
| `tap` | Tap raw device coordinates. |
| `tap_element` | Tap a UI element by ID returned from a snapshot or text search. |
| `swipe` | Perform a swipe gesture. |
| `drag` | Drag between two points. |
| `long_press_drag` | Long-press then drag between two points. |
| `type_text` | Type text into the focused field, including Unicode. |
| `key_event` | Send Android key events such as BACK, HOME, ENTER, and SEARCH. |
| `open_app` | Open an app by launcher label or package name. |
| `launch_app` | Launch an app by exact package name. |
| `adb_shell` | Run narrow Android inspection commands. |
| `list_apps` | List launchable app labels and package names. |
| `list_packages` | List launchable package names. |
| `wait` | Pause between actions. |

For normal UI work, prefer this order:

1. `target_status`
2. `ui_snapshot`, `visible_text`, or `current_app`
3. `find_text` or `wait_for_text`
4. `tap_text` or `tap_element`
5. raw `tap` only when element metadata is unavailable

## Safety Boundaries

OpenPocket can drive apps on an authorized Android target, but the agent should pause for explicit user confirmation before:

- submitting purchases or payments
- sending messages, posts, likes, follows, or irreversible social actions
- changing account, security, privacy, or payment settings
- entering passwords, OTPs, recovery codes, card details, government IDs, or private health/finance data
- using camera, microphone, photos, contacts, files, location, biometric, NFC, or SMS capabilities

## Troubleshooting

### Codex Can See the Skill But Not the Tools

Start a fresh Codex session after installing or updating the plugin. Existing desktop threads may keep the old tool registry.

### The Plugin Cannot Find the MCP Server

Run:

```bash
npm run build
node plugins/openpocket-phone/scripts/doctor.mjs
```

If the server is still not found, set one of:

```bash
export OPENPOCKET_REPO_ROOT=/path/to/openpocket
export OPENPOCKET_MCP_SERVER=/path/to/openpocket/dist/mcp/server.js
```

### Multiple Devices Are Online

Use `target_status`. If more than one target device is online, pass `deviceId` explicitly to every inspection and action tool.

### The Screen Is Blank or Sensitive

Use `secureSurfaceDetected`, `secureSurfaceEvidence`, `visibleTextLines`, and `uiElements` from `screenshot` or `ui_snapshot`. Do not infer sensitive content from a black secure surface.

### Physical Phone Is Not Controllable

Confirm that ADB authorization is granted:

```bash
adb devices -l
```

OpenPocket does not bypass device trust prompts, lock screens, account prompts, or OS security settings.
