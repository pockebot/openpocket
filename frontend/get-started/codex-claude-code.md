# Codex And Claude Code Phone Use

OpenPocket gives Codex and Claude Code native phone-use plugins for Android. Each plugin includes a host-specific manifest, a `phone-use` skill, and the same local MCP runtime with 23 tools. The runtime controls the Android target through ADB instead of clicking the emulator window through desktop Computer Use.

## Choose Your Client

| Client | Install |
| --- | --- |
| Codex CLI | `npm run phone-use:install -- codex` |
| Claude Code CLI | `npm run phone-use:install -- claude-code` |
| Codex Desktop | Install `OpenPocket Phone` from the repository's `OpenPocket Local` marketplace |
| Claude Desktop | Upload the ready-made `openpocket-phone-claude.zip` from Settings > Plugins |

Both Desktop packages contain the compiled MCP runtime. You do not need to run `npm install` or `npm run build` before a Desktop install.

> OpenPocket Phone currently supports Android emulators and ADB-authorized Android devices. It does not support iOS Simulator or iPhone targets yet.

## Requirements

- Node.js 20 or newer
- Android SDK platform-tools (`adb`)
- Android Emulator tools for emulator targets
- an existing AVD or an ADB-authorized Android phone

Set `ANDROID_SDK_ROOT` when the Android SDK is not in its standard location. On first launch, the plugin creates `~/.openpocket/config.json` with an emulator target and `OpenPocket_AVD` as the default AVD name.

## Codex CLI

From the OpenPocket repository root:

```bash
npm run phone-use:install -- codex --target emulator
```

The command installs missing dependencies, builds the development runtime, configures the target, installs the native Codex plugin, and verifies all 23 tools.

Start an existing configured AVD during setup:

```bash
npm run phone-use:install -- codex --target emulator --start-emulator
```

After installation, start a new Codex session. Use `/plugins` inside Codex CLI to inspect the installed plugin.

## Claude Code CLI

From the OpenPocket repository root:

```bash
npm run phone-use:install -- claude-code --target emulator
```

This installs a native Claude plugin at user scope. It does not rely on a raw project `.mcp.json` or a manual `claude mcp add` entry. Start a new Claude Code session, then use `/plugin` and `/mcp` to inspect the loaded skill and server.

## Codex Desktop

The repository includes a Codex marketplace at `.agents/plugins/marketplace.json` and a self-contained plugin at `plugins/openpocket-phone/`.

1. Download or clone OpenPocket.
2. Open the repository folder as a Codex project.
3. Restart Codex Desktop after opening the checkout for the first time.
4. Open **Plugins** and select **OpenPocket Local**.
5. Open **OpenPocket Phone** and install it.
6. Start a new task.

No repository build is required for this Desktop flow.

![OpenPocket Phone installed in Codex Desktop](/images/openpocket-phone/codex-plugin-installed.png)

If `OpenPocket Local` does not appear, run the one-command fallback and restart the app:

```bash
npm run phone-use:install -- codex
```

## Claude Desktop

The upload-ready archive is committed at:

```text
plugins/openpocket-phone-claude/releases/openpocket-phone-claude.zip
```

1. Open Claude Desktop **Settings > Plugins**.
2. Select **Add > Upload plugin**.
3. Choose `openpocket-phone-claude.zip`.
4. Review the local-plugin warning and select **Upload**.
5. Confirm that **OpenPocket Phone** appears in the plugin list.
6. Start a new Claude Code task.

The local upload action is in the Plugins **Add** menu:

![Claude Desktop Add menu with Upload plugin](/images/openpocket-phone/claude-plugin-add-menu.png)

Select the ready-made zip in the upload dialog:

![Claude Desktop local plugin upload dialog](/images/openpocket-phone/claude-plugin-upload.png)

A successful install appears as a native plugin with one bundled skill:

![OpenPocket Phone installed in Claude Desktop](/images/openpocket-phone/claude-plugin-installed.png)

For one-process development tests, Claude Code can load the source folder or zip directly:

```bash
claude --plugin-dir ./plugins/openpocket-phone-claude
claude --plugin-dir ./plugins/openpocket-phone-claude/releases/openpocket-phone-claude.zip
```

## Physical Android Phone

Authorize the device first:

```bash
adb devices -l
```

Then pin the selected serial:

```bash
npm run phone-use:install -- codex --device <serial>
npm run phone-use:install -- claude-code --device <serial>
```

OpenPocket does not bypass Android trust prompts, lock screens, account prompts, or OS security controls.

## First Test

Use a new task after installation:

```text
Use OpenPocket Phone only. Call target_status. If the configured target is an
emulator and no emulator is online, start it. Then report targetType, avdName,
devices, bootedDevices, resolvedDeviceId, resolveError, and ambiguousTarget.
```

Then run a read-only screen check:

```text
Call current_app and ui_snapshot. Report the foreground Android package,
screen size, and visible text. Do not tap or type anything.
```

A successful native test calls these tools directly from the new Codex or Claude Code task. You should not manually start `dist/mcp/server.js`.

## Tool Surface

| Group | Tools |
| --- | --- |
| Target | `target_status`, `start_emulator`, `stop_emulator` |
| Inspect | `current_app`, `screenshot`, `ui_snapshot`, `visible_text`, `find_text`, `wait_for_text` |
| Act | `tap_text`, `tap`, `tap_element`, `swipe`, `drag`, `long_press_drag`, `type_text`, `key_event` |
| Apps and shell | `open_app`, `launch_app`, `adb_shell`, `list_apps`, `list_packages`, `wait` |

Prefer text and element tools over raw coordinates:

1. Confirm the target with `target_status`.
2. Inspect with `ui_snapshot`, `visible_text`, or `current_app`.
3. Locate a control with `find_text` or `wait_for_text`.
4. Act with `tap_text` or `tap_element`.
5. Use raw `tap` only when UI metadata is unavailable.

## Troubleshooting

### Skill Visible, Tools Missing

Start a new task. Plugin tools are resolved when a session starts; existing tasks do not gain newly installed MCP tools.

### Node Or ADB Missing

Confirm both commands work in the host environment:

```bash
node --version
adb devices -l
```

Node must be version 20 or newer. Add Android platform-tools to `PATH`, or set `ANDROID_SDK_ROOT` or `ANDROID_HOME`.

### Wrong Emulator

Set `emulator.avdName` in `~/.openpocket/config.json` to an installed AVD. If more than one ADB device is online, pass `deviceId` explicitly to every inspection and action tool.

### Validate The Bundle

```bash
npm run phone-use:package
node plugins/openpocket-phone/scripts/doctor.mjs
claude plugin validate plugins/openpocket-phone-claude --strict
```

For package internals and maintainer validation, see the [repository integration guide](https://github.com/pockebot/openpocket/blob/main/docs/codex-claude-code-phone-use.md).
