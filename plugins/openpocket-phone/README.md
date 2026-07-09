# OpenPocket Phone Plugins

OpenPocket Phone lets Codex and Claude Code operate an Android emulator or an ADB-authorized physical Android phone with native phone-use tools. It does not drive the emulator window through desktop Computer Use. The host loads a plugin, the plugin starts a local MCP server, and that server talks to Android through ADB.

OpenPocket ships two independent native packages:

| Host | Package | Includes |
| --- | --- | --- |
| Codex CLI and Codex Desktop | [`plugins/openpocket-phone/`](./) | Codex manifest, `phone-use` skill, bundled 23-tool MCP runtime |
| Claude Code CLI and Claude Desktop | [`plugins/openpocket-phone-claude/`](../openpocket-phone-claude/) | Claude plugin manifest, `phone-use` skill, bundled 23-tool MCP runtime, upload-ready zip |

Both packages are self-contained. Desktop users do not need to run `npm install` or `npm run build` before installing them.

> OpenPocket Phone is Android-first. iOS Simulator and iPhone targets are not supported by this plugin yet.

## Requirements

- Node.js 20 or newer
- Android SDK platform-tools (`adb`)
- Android Emulator tools for an emulator target
- an existing AVD, or an Android device that has authorized this computer for ADB

Set `ANDROID_SDK_ROOT` when the Android SDK is not in its default location. The first plugin launch creates an emulator-first config at `~/.openpocket/config.json` with `OpenPocket_AVD` as the default AVD name.

## Pick An Install Path

| Client | Fastest path |
| --- | --- |
| Codex CLI | Run the one-command installer: `npm run phone-use:install -- codex` |
| Claude Code CLI | Run the one-command installer: `npm run phone-use:install -- claude-code` |
| Codex Desktop | Open this repository in Codex, install from the `OpenPocket Local` repo marketplace, then start a new task |
| Claude Desktop | Upload [`openpocket-phone-claude.zip`](../openpocket-phone-claude/releases/openpocket-phone-claude.zip) from Settings > Plugins |

## Codex CLI

From the OpenPocket repository root:

```bash
npm run phone-use:install -- codex --target emulator
```

The installer finds Codex CLI or the CLI embedded in Codex Desktop, installs missing repository dependencies, builds the development runtime, configures the target, installs `openpocket-phone@openpocket-local`, and runs the 23-tool Doctor check.

Start the emulator during installation when the configured AVD already exists:

```bash
npm run phone-use:install -- codex --target emulator --start-emulator
```

Verify the plugin, then start a new Codex session:

```bash
codex plugin list
codex
```

Inside Codex CLI, `/plugins` opens the plugin browser. Existing sessions keep their original tool registry, so always use a new session after installing or updating the plugin.

## Claude Code CLI

From the OpenPocket repository root:

```bash
npm run phone-use:install -- claude-code --target emulator
```

This installs the native Claude plugin. It does not add a legacy raw `claude mcp add` entry. If an older user-scoped `openpocket-phone` MCP entry exists, the installer backs up the Claude config before removing only that legacy entry.

Verify the plugin, then start a new Claude Code session:

```bash
claude plugin list
claude
```

Inside Claude Code, use `/plugin` to inspect the plugin and `/mcp` to inspect its bundled server. Plugin tools are namespaced by Claude automatically.

The installer also discovers the Claude Code binary embedded in Claude Desktop on macOS, so a separate global `claude` installation is not required when the desktop app is already installed.

## Codex Desktop

Codex Desktop can install this plugin from the repository marketplace without a source build:

1. Download or clone OpenPocket and open the repository folder as a Codex project.
2. Restart Codex Desktop after opening the checkout for the first time.
3. Open **Plugins** from Codex.
4. Select the **OpenPocket Local** marketplace.
5. Open **OpenPocket Phone** and install it.
6. Start a new task so Codex can load the skill and MCP tools.

The repository already contains `.agents/plugins/marketplace.json`, the Codex plugin manifest, and the bundled runtime. No `npm install` or `npm run build` step is required for this Desktop flow.

![OpenPocket Phone installed in Codex Desktop](assets/onboarding/codex-plugin-installed.png)

If the repo marketplace does not appear, register and install it with the one-command fallback:

```bash
npm run phone-use:install -- codex
```

Then restart Codex Desktop and start a new task.

## Claude Desktop

Claude Desktop accepts the native Claude Code plugin as a local zip. The release archive already contains the skill, MCP registration, helper APK, and bundled JavaScript runtime.

1. Download or locate [`plugins/openpocket-phone-claude/releases/openpocket-phone-claude.zip`](../openpocket-phone-claude/releases/openpocket-phone-claude.zip).
2. Open Claude Desktop **Settings > Plugins**.
3. Select **Add > Upload plugin**.
4. Select `openpocket-phone-claude.zip`, review the local-plugin warning, and select **Upload**.
5. Confirm that **OpenPocket Phone** appears in the plugin list.
6. Start a new Claude Code task.

The **Add** menu exposes the local upload action:

![Claude Desktop Add menu with Upload plugin](assets/onboarding/claude-plugin-add-menu.png)

Upload the ready-made zip. This path does not require a repository build:

![Claude Desktop local plugin upload dialog](assets/onboarding/claude-plugin-upload.png)

A successful install appears as a native plugin with the bundled skill:

![OpenPocket Phone installed in Claude Desktop](assets/onboarding/claude-plugin-installed.png)

For local plugin development, Claude Code can also load the directory or zip without installing it:

```bash
claude --plugin-dir ./plugins/openpocket-phone-claude
claude --plugin-dir ./plugins/openpocket-phone-claude/releases/openpocket-phone-claude.zip
```

## Physical Android Phone

Connect and authorize the phone first:

```bash
adb devices -l
```

Then pin the plugin target to the device serial with either installer:

```bash
npm run phone-use:install -- codex --device <serial>
npm run phone-use:install -- claude-code --device <serial>
```

OpenPocket does not bypass Android trust prompts, lock screens, account prompts, or OS security controls.

## First Test

Use this prompt in a new Codex or Claude Code task:

```text
Use OpenPocket Phone only. Call target_status. If the configured target is an
emulator and no emulator is online, start it. Then report targetType, avdName,
devices, bootedDevices, resolvedDeviceId, resolveError, and ambiguousTarget.
```

A healthy emulator setup normally reports an emulator target, one booted emulator, a resolved device ID such as `emulator-5554`, and no resolve error.

Continue with a read-only UI check:

```text
Use OpenPocket Phone to call current_app and ui_snapshot. Report the foreground
Android package, screen size, and visible text. Do not tap or type anything.
```

## Tool Surface

The bundled MCP server exposes 23 tools:

| Group | Tools |
| --- | --- |
| Target | `target_status`, `start_emulator`, `stop_emulator` |
| Inspect | `current_app`, `screenshot`, `ui_snapshot`, `visible_text`, `find_text`, `wait_for_text` |
| Act | `tap_text`, `tap`, `tap_element`, `swipe`, `drag`, `long_press_drag`, `type_text`, `key_event` |
| Apps and shell | `open_app`, `launch_app`, `adb_shell`, `list_apps`, `list_packages`, `wait` |

For normal phone use, prefer text and element tools before raw coordinates:

1. `target_status`
2. `ui_snapshot`, `visible_text`, or `current_app`
3. `find_text` or `wait_for_text`
4. `tap_text` or `tap_element`
5. raw `tap` only when UI metadata is unavailable

## What Gets Installed

| Path | Purpose |
| --- | --- |
| `.codex-plugin/plugin.json` | Codex plugin metadata |
| `.mcp.json` | Codex MCP server registration |
| `skills/phone-use/SKILL.md` | Phone-use workflow and safety instructions |
| `runtime/openpocket-phone-server.mjs` | Self-contained 23-tool MCP server |
| `runtime/openpocket-ime.apk` | Unicode-safe Android text input helper |
| `runtime/screen-awake-worker.js` | Screen-awake helper used by the runtime |
| `scripts/doctor.mjs` | Manifest, runtime, and tool inventory validation |

The Claude package has the same runtime files under `plugins/openpocket-phone-claude/`, plus its own `.claude-plugin/plugin.json` and upload-ready release archive.

## Troubleshooting

### The Skill Is Visible But The Tools Are Missing

Start a new task after installation. Codex and Claude Code resolve plugin tools when a session starts; an existing task does not gain newly installed MCP tools retroactively.

### Codex Does Not Show OpenPocket Local

Open the OpenPocket checkout as the active Codex project and restart the desktop app. The marketplace file is `.agents/plugins/marketplace.json`. The fallback installer registers the same marketplace explicitly:

```bash
npm run phone-use:install -- codex
```

### Claude Desktop Does Not Show Plugins Or Upload Plugin

Update Claude Desktop and confirm that the Plugins settings surface is enabled for the signed-in account or workspace. As a fallback, use the Claude Code CLI installer or `claude --plugin-dir` flow documented above.

### Node Or ADB Is Not Found

Confirm the host can run both commands:

```bash
node --version
adb devices -l
```

Node must be version 20 or newer. Add Android platform-tools to `PATH`, or set `ANDROID_SDK_ROOT` or `ANDROID_HOME`.

### The Wrong Emulator Is Selected

Edit `emulator.avdName` in `~/.openpocket/config.json`, or use the OpenPocket CLI to configure the target. When more than one ADB device is online, pass `deviceId` explicitly to inspection and action tools.

### Rebuild The Bundles During Development

From the repository root:

```bash
npm install
npm run phone-use:package
node plugins/openpocket-phone/scripts/doctor.mjs
```

The package command rebuilds the shared runtime, synchronizes the Codex bundle, and refreshes the Claude Desktop zip.
