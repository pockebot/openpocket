# Codex and Claude Code Phone Use

OpenPocket can expose the same local Android control layer to Codex and Claude Code. The OpenPocket runtime still owns the emulator or physical-phone target; Codex and Claude Code receive a focused MCP tool surface for phone use.

## Integration Shape

| Layer | Codex | Claude Code |
| --- | --- | --- |
| Package | `plugins/openpocket-phone/` local Codex plugin | project `.mcp.json` or manual MCP registration |
| Instructions | `phone-use` skill in the plugin | Claude prompt plus MCP tools |
| Transport | stdio MCP server launched by the plugin wrapper | stdio MCP server launched directly |
| Runtime | `src/mcp/server.ts` backed by OpenPocket ADB runtime | same `src/mcp/server.ts` |
| Targets | Android emulator or authorized physical Android device | Android emulator or authorized physical Android device |

The Codex plugin is intentionally separate from the main OpenPocket runtime. It packages:

- a plugin manifest
- the `phone-use` skill
- the `openpocket-phone` MCP server registration
- helper scripts for server discovery and diagnostics

Claude Code does not use the Codex plugin manifest or skill. It connects to the same MCP server directly.

## Prerequisites

```bash
npm install
npm run build
```

You also need Node.js 20 or newer, Android SDK platform-tools, and either a configured emulator or an authorized Android phone.

For an emulator:

```bash
openpocket target set --type emulator
openpocket emulator start
```

For a physical Android phone:

```bash
adb devices -l
openpocket target set --type physical-phone --device <serial>
```

## Install for Codex

From the OpenPocket repository root:

```bash
codex plugin marketplace add /path/to/openpocket
codex plugin add openpocket-phone@openpocket-local
```

Start a fresh Codex thread or fresh `codex exec` process after installing or updating the plugin. Existing desktop threads may not pick up newly installed local MCP tools.

Verify the bundle without touching a phone target:

```bash
node plugins/openpocket-phone/scripts/doctor.mjs
```

Expected result:

- plugin name: `openpocket-phone`
- MCP server name: `openpocket-phone`
- tool count: `23`
- required tools include `ui_snapshot`, `visible_text`, `find_text`, `wait_for_text`, `tap_text`, `open_app`, and `list_apps`

In a fresh Codex session, ask Codex to call `target_status` with the native OpenPocket MCP tool. A successful response should report the configured target type, AVD name, online devices, booted devices, resolved device ID, and any resolve error.

## Install for Claude Code

### Project-Scoped

Build OpenPocket and open Claude Code from the repository root:

```bash
npm run build
claude
```

The repository root contains `.mcp.json`:

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

Inside Claude Code:

```text
/mcp
```

You should see `openpocket-phone` with 23 tools.

### Manual Registration

```bash
claude mcp add --transport stdio openpocket-phone -- \
  node /path/to/openpocket/dist/mcp/server.js
```

With a custom config:

```bash
claude mcp add --transport stdio openpocket-phone -- \
  node /path/to/openpocket/dist/mcp/server.js \
  --config /path/to/openpocket.config.json
```

## Recommended Tool Flow

Use high-level read and text tools before raw coordinates:

1. `target_status` to confirm the target and device ambiguity.
2. `ui_snapshot`, `visible_text`, or `current_app` to inspect state.
3. `find_text` or `wait_for_text` to locate UI.
4. `tap_text` or `tap_element` to act on UI metadata.
5. raw `tap` only when metadata is unavailable.

Useful tools:

| Tool | Purpose |
| --- | --- |
| `ui_snapshot` | Text-only UI metadata without image payloads. |
| `visible_text` | Visible/accessibility text with source element IDs. |
| `find_text` | Match UI elements by text, content description, resource ID, or class name. |
| `wait_for_text` | Wait for a screen state after launch, navigation, search, or scroll. |
| `tap_text` | Tap by visible text or resource ID. |
| `open_app` | Open by launcher label or package name. |
| `screenshot` | Capture image content plus UI metadata, secure-surface status, and metrics. |

## Safety and Boundaries

The MCP server can drive the authorized target, so agents should pause before sensitive or irreversible actions:

- payments and purchases
- messages, posts, follows, likes, or other social actions
- account, privacy, security, or payment setting changes
- passwords, OTPs, recovery codes, card details, government IDs, or private health/finance data
- camera, microphone, photos, contacts, files, location, biometric, NFC, or SMS use

OpenPocket is Android-first. This MCP surface does not control iOS Simulator or iPhone targets yet.

## Troubleshooting

If Codex sees the skill but not the MCP tools, open a new thread or run a fresh `codex exec` session.

If the plugin cannot find the MCP server:

```bash
npm run build
node plugins/openpocket-phone/scripts/doctor.mjs
```

If multiple devices are online, pass `deviceId` explicitly to every inspection and action tool.

If a physical phone is not controllable, check ADB authorization:

```bash
adb devices -l
```

OpenPocket does not bypass trust prompts, lock screens, account prompts, or OS security settings.
