# OpenPocket Phone Plugin

OpenPocket Phone lets Codex and Claude use the same local Android phone-use layer. It can control an Android emulator or an authorized physical Android device through OpenPocket's ADB runtime.

Use this when you want an agent to operate a phone target directly, not through desktop computer-use automation.

## What This Package Contains

| Path | Purpose |
| --- | --- |
| `.codex-plugin/plugin.json` | Codex plugin manifest and display metadata. |
| `.mcp.json` | MCP server registration used by Codex when the plugin is installed. |
| `skills/phone-use/SKILL.md` | Codex instructions for safe Android phone use. |
| `scripts/openpocket-phone-mcp.mjs` | Codex wrapper that finds and starts the OpenPocket Phone MCP server. |
| `scripts/doctor.mjs` | Local preflight for the plugin, wrapper, MCP server, and expected tools. |

Claude Code does not use the Codex plugin manifest or skill. It connects to the same MCP server directly.

## Choose The Right Install Path

| Client | What to install | Recommended path |
| --- | --- | --- |
| Codex CLI | Codex plugin | Add the local OpenPocket marketplace, then install `openpocket-phone@openpocket-local`. |
| Codex Desktop App | Codex plugin | Install the same plugin with Codex CLI, then restart the desktop app and start a fresh thread. |
| Claude Code CLI | MCP server | Use the project `.mcp.json` or run `claude mcp add`. |
| Claude Code Desktop App | MCP server | Register a Claude Code user-scoped MCP server, then restart/open the desktop app. |
| Claude Desktop chat app | MCP server | Edit `claude_desktop_config.json` through Settings > Developer > Edit Config. |

This package currently ships a Codex plugin and a raw MCP server. It does not yet ship a Claude Desktop `.mcpb` extension package, so Claude desktop users should use MCP configuration for now.

## Before Installing

From the OpenPocket repository root:

```bash
npm install
npm run build
```

Configure a target:

```bash
# Emulator target
openpocket target set --type emulator
openpocket emulator start
```

Or use an authorized physical Android phone:

```bash
adb devices -l
openpocket target set --type physical-phone --device <serial>
```

Run the plugin preflight:

```bash
node plugins/openpocket-phone/scripts/doctor.mjs
```

Expected result:

- `pluginName: "openpocket-phone"`
- `mcpServerName: "openpocket-phone"`
- `toolCount: 23`
- required tools include `target_status`, `ui_snapshot`, `visible_text`, `find_text`, `wait_for_text`, `tap_text`, `open_app`, and `list_apps`

## Install For Codex CLI

Install the local OpenPocket marketplace and plugin:

```bash
cd /path/to/openpocket
npm install
npm run build
codex plugin marketplace add /path/to/openpocket
codex plugin add openpocket-phone@openpocket-local
```

Verify that Codex can see it:

```bash
codex plugin list | grep openpocket-phone
```

Start a fresh Codex CLI session. Existing sessions may keep the old tool registry.

```bash
codex exec --cd /path/to/openpocket \
  "Use only the openpocket-phone plugin. Call target_status and report the target."
```

If the plugin loaded correctly, Codex should be able to call `target_status` without you manually starting `dist/mcp/server.js`.

## Install For Codex Desktop App

Codex Desktop uses the same local plugin registry as Codex CLI. For a local development checkout, the most reliable desktop install flow is:

1. Open Terminal.
2. Register and install the plugin once:

   ```bash
   cd /path/to/openpocket
   npm install
   npm run build
   codex plugin marketplace add /path/to/openpocket
   codex plugin add openpocket-phone@openpocket-local
   ```

3. Fully quit and reopen the Codex Desktop app.
4. Start a new thread.
5. Ask Codex:

   ```text
   Use the openpocket-phone plugin. Call target_status and tell me which Android target is ready.
   ```

If your Codex Desktop build has a Plugins UI, you can also install from the local marketplace entry:

- marketplace root: `/path/to/openpocket`
- marketplace file: `/path/to/openpocket/.agents/plugins/marketplace.json`
- plugin id: `openpocket-phone@openpocket-local`

After installing or updating the plugin, use a new Codex thread. Old desktop threads may not pick up newly installed MCP tools.

## Install For Claude Code CLI

Claude Code uses MCP directly. It does not install the Codex plugin.

### Option A: Project-Scoped MCP

Open Claude Code from the OpenPocket repository root after building:

```bash
cd /path/to/openpocket
npm install
npm run build
claude
```

The repository root includes `.mcp.json`:

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

### Option B: Manual MCP Registration

Use this when you want the MCP server available outside the OpenPocket repository.

```bash
claude mcp add --transport stdio openpocket-phone -- \
  node /path/to/openpocket/dist/mcp/server.js \
  --config /path/to/openpocket/openpocket.config.json
```

Then restart Claude Code and check:

```text
/mcp
```

## Install For Claude Code Desktop App

Claude Code stores user-scoped MCP servers in Claude Code settings, so the most reliable desktop-app setup is to register the MCP server once from Terminal and then use the desktop app.

Build OpenPocket first:

```bash
cd /path/to/openpocket
npm install
npm run build
```

Register the server for all Claude Code projects for your user:

```bash
claude mcp add --scope user --transport stdio openpocket-phone -- \
  node /path/to/openpocket/dist/mcp/server.js \
  --config /path/to/openpocket/openpocket.config.json
```

Then:

1. Fully quit and reopen the Claude Code Desktop app.
2. Start or reopen a Claude Code session.
3. Open the MCP panel if available, or ask Claude Code:

   ```text
   Use the openpocket-phone MCP server and call target_status.
   ```

If you want this server only for the OpenPocket repository, open Claude Code Desktop from this project and use the repository's project-scoped `.mcp.json` instead. The first run may ask you to trust the workspace and approve the project MCP server.

## Install For Claude Desktop App

Claude Desktop chat apps use an MCP config file for local MCP servers. Add `openpocket-phone` to the app's MCP server config, then fully restart the app.

In the app, use Settings > Developer > Edit Config. On macOS, the file is commonly:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Use absolute paths:

```json
{
  "mcpServers": {
    "openpocket-phone": {
      "command": "node",
      "args": [
        "/path/to/openpocket/dist/mcp/server.js",
        "--config",
        "/path/to/openpocket/openpocket.config.json"
      ]
    }
  }
}
```

Then:

1. Save the config file.
2. Fully quit and reopen Claude Desktop.
3. Start a new chat.
4. Ask Claude to use `openpocket-phone` and call `target_status`.

If your desktop app has an MCP settings screen instead of direct JSON editing, add the same server:

- server name: `openpocket-phone`
- command: `node`
- arguments:
  - `/path/to/openpocket/dist/mcp/server.js`
  - `--config`
  - `/path/to/openpocket/openpocket.config.json`

## First Test Prompt

Use this prompt in Codex or Claude after installation:

```text
Use the openpocket-phone tools only. Call target_status. If an emulator target is configured but no booted device is online, start the emulator. Then report targetType, avdName, devices, bootedDevices, resolvedDeviceId, resolveError, and ambiguousTarget.
```

For a UI smoke test:

```text
Use openpocket-phone. Open Android Settings, read the current screen with ui_snapshot and visible_text, find a safe settings item with find_text, tap it with tap_text or tap_element, go back with key_event BACK, take a screenshot, then return home with key_event HOME.
```

## Troubleshooting

### Codex Can See The Skill But Not The Tools

Start a new Codex CLI session or a new Codex Desktop thread. If the desktop app was already open during installation, fully restart it.

### Plugin Was Updated But Codex Still Uses Old Behavior

Reinstall the local plugin:

```bash
codex plugin remove openpocket-phone@openpocket-local
codex plugin add openpocket-phone@openpocket-local
```

Then start a fresh session.

### MCP Server Cannot Be Found

Build OpenPocket and run doctor:

```bash
npm run build
node plugins/openpocket-phone/scripts/doctor.mjs
```

If needed, set explicit paths:

```bash
export OPENPOCKET_REPO_ROOT=/path/to/openpocket
export OPENPOCKET_MCP_SERVER=/path/to/openpocket/dist/mcp/server.js
```

### Multiple Android Devices Are Online

Call `target_status`. If more than one target device is online, pass `deviceId` explicitly to every phone-use tool.

### Physical Phone Does Not Work

OpenPocket does not bypass Android trust prompts, lock screens, account prompts, or OS security settings. Confirm ADB authorization first:

```bash
adb devices -l
```

### Sensitive Screens

If `screenshot` reports `secureSurfaceDetected`, do not infer private content from the image. Use UI metadata only and ask the user before continuing.
