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

Start a new Codex thread after installing the plugin so Codex can load the `phone-use` skill and the `openpocket-phone` MCP tools.

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
| `screenshot` | Capture screen PNG content with UI element metadata |
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

You should see `openpocket-phone` listed with 13 tools.
