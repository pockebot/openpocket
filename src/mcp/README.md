# OpenPocket Emulator MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes Android emulator control as tools for Claude Code and other MCP clients.

## Prerequisites

- Node.js >= 20
- Android SDK with emulator and ADB installed
- An AVD (Android Virtual Device) configured via `openpocket.config.json`

## Install

From the project root:

```bash
npm install
npm run build
```

## Usage with Claude Code

### Option 1: Project-scoped (automatic)

The `.mcp.json` at the project root auto-registers the server when you open Claude Code in this directory. Just restart Claude Code after building.

### Option 2: Manual registration

```bash
claude mcp add --transport stdio openpocket-emulator -- node /path/to/openpocket/dist/mcp/server.js
```

### Option 3: With custom config path

```bash
claude mcp add --transport stdio openpocket-emulator -- node /path/to/openpocket/dist/mcp/server.js --config /path/to/openpocket.config.json
```

## Available Tools

| Tool | Description |
|------|-------------|
| `emulator_status` | Get AVD name, online devices, booted devices |
| `emulator_start` | Boot the emulator (optional headless mode) |
| `emulator_stop` | Stop the running emulator |
| `screenshot` | Capture screen as base64 PNG with UI element metadata |
| `tap` | Tap at pixel coordinates |
| `tap_element` | Tap a UI element by ID (from screenshot metadata) |
| `swipe` | Swipe gesture between two points |
| `type_text` | Type text into focused input (Unicode-safe) |
| `key_event` | Send Android key events (BACK, HOME, ENTER, etc.) |
| `launch_app` | Launch an app by package name |
| `adb_shell` | Run arbitrary ADB shell commands |
| `list_packages` | List all launchable apps on the device |
| `wait` | Pause between actions |

## Verify

After registering, check that the server is running inside Claude Code:

```
/mcp
```

You should see `openpocket-emulator` listed with 13 tools.
