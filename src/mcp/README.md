# OpenPocket Phone MCP Server

This module implements the shared Android phone-control server used by the native Codex and Claude Code plugins. It exposes 23 MCP tools backed by OpenPocket's ADB runtime for emulator and authorized physical-phone targets.

End users should install a native plugin instead of registering this source server manually:

- [OpenPocket Phone plugin onboarding](../../plugins/openpocket-phone/README.md)
- [Integration architecture and validation](../../docs/codex-claude-code-phone-use.md)
- [Website setup guide](https://www.openpocket.ai/get-started/codex-claude-code)

## Integration Boundary

| Host | Native package |
| --- | --- |
| Codex CLI and Desktop | `plugins/openpocket-phone/codex/openpocket-phone/` |
| Claude Code CLI and Desktop | `plugins/openpocket-phone/claude/openpocket-phone/` |

Both install roots belong to the single `plugins/openpocket-phone/` integration. Each includes a host-specific manifest, a generated copy of the shared `phone-use` skill, an MCP registration, and a self-contained runtime generated from `src/mcp/server.ts`. Installed plugins do not depend on the repository's `dist/` directory.

## Requirements

- Node.js 20 or newer
- Android SDK platform-tools and emulator tools
- an existing AVD or an ADB-authorized Android device

The runtime reads `~/.openpocket/config.json` and creates an emulator-first default when the file is missing.

## Install Native Plugins

From the repository root:

```bash
npm run phone-use:install -- codex --target emulator
npm run phone-use:install -- claude-code --target emulator
```

For Desktop screenshots and no-build install paths, see the [plugin onboarding guide](../../plugins/openpocket-phone/README.md).

## Run The Source Server For Development

Build and start the source MCP server only when developing or debugging this module:

```bash
npm install
npm run build
node dist/mcp/server.js
```

Use a custom config path when needed:

```bash
node dist/mcp/server.js --config /absolute/path/to/config.json
```

Rebuild both plugin runtimes and the Claude Desktop archive:

```bash
npm run phone-use:package
```

## Available Tools

| Tool | Description |
| --- | --- |
| `target_status` | Inspect configured target, online devices, booted emulators, and target resolution |
| `start_emulator` | Start the configured emulator target |
| `stop_emulator` | Stop the configured emulator target |
| `current_app` | Inspect foreground app and screenshot hash without image payloads |
| `screenshot` | Capture PNG content, UI metadata, visible text, secure-surface status, and metrics |
| `ui_snapshot` | Capture text-only UI metadata without image payloads |
| `visible_text` | Return visible and accessibility text with source element IDs |
| `find_text` | Find UI elements by text, content description, resource ID, or class |
| `wait_for_text` | Poll until matching UI text appears |
| `tap_text` | Tap the best matching text or resource-ID element |
| `tap` | Tap pixel coordinates |
| `tap_element` | Tap an element ID returned by an inspection tool |
| `swipe` | Swipe between two points |
| `drag` | Drag between two points |
| `long_press_drag` | Long-press and drag between two points |
| `type_text` | Enter Unicode text through the OpenPocket IME helper |
| `key_event` | Send Android key events such as BACK, HOME, or ENTER |
| `open_app` | Open an app by launcher label or package name |
| `launch_app` | Launch an app by exact package name |
| `adb_shell` | Run narrow Android shell commands |
| `list_apps` | List launchable app labels and package names |
| `list_packages` | List launchable package names |
| `wait` | Pause between actions |

Prefer `ui_snapshot`, `visible_text`, `find_text`, `tap_text`, `wait_for_text`, and `open_app` before raw coordinate taps.

## Validate

```bash
npm run phone-use:package
node plugins/openpocket-phone/scripts/doctor.mjs
node --test test/codex-phone-plugin.test.mjs test/claude-phone-plugin.test.mjs test/phone-plugin-layout.test.mjs
```

A full native acceptance test must use a fresh Codex or Claude Code session and call `target_status` through the plugin-provided tool. Starting `dist/mcp/server.js` manually proves only the server, not native plugin loading.
