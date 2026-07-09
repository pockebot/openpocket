# OpenPocket Phone MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes Android phone interaction as tools for Codex, Claude Code, and other MCP clients. It controls OpenPocket Android targets through ADB, including emulator targets and physical-phone targets selected in OpenPocket config.

## Prerequisites

- Node.js >= 20
- Android SDK with emulator and ADB installed
- An OpenPocket target configured via `openpocket.config.json`
- For emulator targets: an AVD configured in OpenPocket
- For physical-phone targets: USB debugging or Wi-Fi ADB authorized for this host

## Install

From the project root:

```bash
npm install
npm run build
```

## Usage with Codex

Use the bundled Codex plugin in this repository:

```bash
npm install
npm run build
codex plugin marketplace add /path/to/openpocket
codex plugin add openpocket-phone@openpocket-local
```

Start a fresh Codex session after installing the plugin so Codex can load the `phone-use` skill and the `openpocket-phone` MCP tools. If the Codex desktop app was already running before installation, restart the app or use a fresh `codex exec` process to verify newly installed local MCP tools.

To verify the local plugin bundle without touching a phone target:

```bash
node plugins/openpocket-phone/scripts/doctor.mjs
```

## Usage with Claude Code

### Option 1: Project-scoped

The `.mcp.json` at the project root auto-registers the server when you open Claude Code in this directory. Restart Claude Code after building.

### Option 2: Manual registration

```bash
claude mcp add --transport stdio openpocket-phone -- node /path/to/openpocket/dist/mcp/server.js
```

### Option 3: With custom config path

```bash
claude mcp add --transport stdio openpocket-phone -- node /path/to/openpocket/dist/mcp/server.js --config /path/to/openpocket.config.json
```

## Available Tools

| Tool | Description |
|------|-------------|
| `target_status` | Inspect configured target and online ADB devices |
| `start_emulator` | Start the configured emulator target |
| `stop_emulator` | Stop the configured emulator target |
| `current_app` | Inspect the foreground app and screenshot hash without image payloads |
| `screenshot` | Capture screen PNG content, UI metadata, visible text, secure-surface status, and capture metrics |
| `ui_snapshot` | Capture text-only UI metadata without image payloads |
| `visible_text` | Return visible/accessibility text with source element IDs |
| `find_text` | Find UI elements by text, content description, resource ID, or class name |
| `wait_for_text` | Poll until matching UI text appears |
| `tap_text` | Tap the best matching UI element by visible text or resource ID |
| `tap` | Tap at pixel coordinates |
| `tap_element` | Tap a UI element by ID from screenshot, ui_snapshot, visible_text, or find_text |
| `swipe` | Swipe gesture between two points |
| `drag` | Drag between two points |
| `long_press_drag` | Long-press then drag between two points |
| `type_text` | Type text into focused input (Unicode-safe) |
| `key_event` | Send Android key events (BACK, HOME, ENTER, etc.) |
| `open_app` | Open an app by launcher label or package name |
| `launch_app` | Launch an app by exact package name |
| `adb_shell` | Run arbitrary ADB shell commands |
| `list_apps` | List launchable app labels and package names |
| `list_packages` | List launchable app package names |
| `wait` | Pause between actions |

For normal phone use, prefer `ui_snapshot`, `visible_text`, `find_text`, `tap_text`, `wait_for_text`, and `open_app` before falling back to raw coordinate taps.

## Verify

After registering, check that the server is running inside Claude Code:

```
/mcp
```

You should see `openpocket-phone` listed with 23 tools.
