# OpenPocket Phone Integration

OpenPocket Phone lets Codex and Claude Code operate an Android emulator or an ADB-authorized physical Android phone with native phone-use tools. It does not drive the emulator window through desktop Computer Use. The host loads a plugin, the plugin starts a local MCP server, and that server talks to Android through ADB.

OpenPocket ships one integration with two host adapters. Codex and Claude Code require different manifest formats and cache each installed plugin from a separate root, so each host still receives a self-contained bundle. They are not separate phone-use implementations: both adapters are generated from the same MCP source and the same canonical skill.

| Layer | Path | Responsibility |
| --- | --- | --- |
| Shared source | [`shared/`](shared/) | Canonical `phone-use` skill; the MCP implementation remains in `src/mcp/server.ts` |
| Codex adapter | [`codex/openpocket-phone/`](codex/openpocket-phone/) | Codex manifest, generated skill copy, and bundled 23-tool MCP runtime |
| Claude adapter | [`claude/openpocket-phone/`](claude/openpocket-phone/) | Claude manifest, generated skill copy, bundled runtime, and upload-ready zip |
| Build and install | [`scripts/`](scripts/) | One packaging pipeline, Doctor validation, and one-command host installers |

The generated runtime and skill copies are byte-identical across both adapters, and automated tests enforce that invariant. Both install bundles are self-contained. Desktop users do not need to run `npm install` or `npm run build` before installing them.

## Why There Are Two Host Bundles

Codex looks for `.codex-plugin/plugin.json` and resolves MCP paths relative to the Codex plugin root. Claude Code looks for `.claude-plugin/plugin.json`, supports `${CLAUDE_PLUGIN_ROOT}`, and accepts an uploadable zip in Claude Desktop. Combining those files into one install root would make host ownership ambiguous and would not produce a clean Claude upload artifact.

The directories under `codex/` and `claude/` therefore contain thin host adapters, not forks. Maintainers edit the shared skill or the core MCP source, then run `npm run phone-use:package` to regenerate both adapters.

> OpenPocket Phone is Android-first. iOS Simulator and iPhone targets are not supported by this plugin yet.

## Requirements

The Desktop bundles remove the repository build step. They do not install the Android host environment.

| Component | Included in the plugin | Required for |
| --- | --- | --- |
| Host manifest, `phone-use` skill, 23-tool MCP runtime, and helper APK | Yes | Every install |
| Node.js 20 or newer | No | Every install; use a current LTS release when possible |
| Android SDK platform-tools (`adb`) | No | Emulator and physical-device targets |
| Android Emulator, a system image, and an existing AVD | No | Emulator targets only |
| Android Studio | No | Optional; it is the easiest way to install and manage the Android SDK and AVDs |
| JDK | No | Not required by the plugin itself |

For an emulator, prepare Node.js 20+, `adb`, Android Emulator, a system image, and an existing AVD. For a physical Android phone, prepare Node.js 20+, `adb`, and authorize the computer for USB or wireless debugging; Emulator tools and a JDK are not required.

Set `ANDROID_SDK_ROOT` when the Android SDK is not in its default location. The first plugin launch creates an emulator-first config at `~/.openpocket/config.json` with `OpenPocket_AVD` as the default AVD name.

### Prepare An Emulator

1. [Install a current Node.js LTS release](https://nodejs.org/en/download), then confirm `node --version` reports 20 or newer.
2. [Install Android Studio](https://developer.android.com/studio/install).
3. Open **Tools > SDK Manager > SDK Tools** and install **Android SDK Platform-Tools** and **Android Emulator**. In **SDK Platforms**, install at least one Android system image.
4. Open **Tools > Device Manager**, [create a virtual device](https://developer.android.com/studio/run/managing-avds), and name it `OpenPocket_AVD` for the zero-configuration path.
5. Put the SDK's `platform-tools` and `emulator` directories on `PATH`, or set `ANDROID_SDK_ROOT` so OpenPocket can discover them.

Verify the host before installing the plugin:

```bash
node --version
adb version
emulator -list-avds
```

The AVD list should contain `OpenPocket_AVD`. To use a differently named AVD, install the plugin without `--start-emulator`, then set `emulator.avdName` in `~/.openpocket/config.json` before starting the emulator.

### Prepare A Physical Android Phone

1. Install a current Node.js LTS release and Android SDK Platform-Tools. Android Studio is optional for this path.
2. Follow Android's [hardware-device setup](https://developer.android.com/studio/run/device) to enable Developer options and USB debugging, or enable Wireless debugging.
3. Connect the phone, keep it unlocked, and accept the ADB authorization prompt for this computer.
4. Run `adb devices -l` and confirm the device state is `device`, not `unauthorized` or `offline`.

A physical-phone target does not require Android Emulator, a system image, an AVD, or a JDK.

## Pick An Install Path

Clone or download the [OpenPocket repository](https://github.com/pockebot/openpocket) first. CLI installers run from the repository root; Desktop installs use the self-contained bundles already committed in the checkout.

```bash
git clone https://github.com/pockebot/openpocket.git
cd openpocket
```

| Client | Fastest path |
| --- | --- |
| Codex CLI | Run the one-command installer: `npm run phone-use:install -- codex` |
| Claude Code CLI | Run the one-command installer: `npm run phone-use:install -- claude-code` |
| Codex Desktop | Open this repository in Codex, install from the `OpenPocket Local` repo marketplace, then start a new task |
| Claude Desktop | Upload [`openpocket-phone-claude.zip`](claude/openpocket-phone/releases/openpocket-phone-claude.zip) from Settings > Plugins |

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

This installs or updates the native Claude plugin. It does not add a legacy raw `claude mcp add` entry. If an older user-scoped `openpocket-phone` MCP entry exists, the installer backs up the Claude config before removing only that legacy entry.

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

1. Download or locate [`plugins/openpocket-phone/claude/openpocket-phone/releases/openpocket-phone-claude.zip`](claude/openpocket-phone/releases/openpocket-phone-claude.zip).
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
claude --plugin-dir ./plugins/openpocket-phone/claude/openpocket-phone
claude --plugin-dir ./plugins/openpocket-phone/claude/openpocket-phone/releases/openpocket-phone-claude.zip
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

## Repository Layout

| Path | Purpose |
| --- | --- |
| `shared/skills/phone-use/SKILL.md` | Canonical workflow and safety instructions |
| `codex/openpocket-phone/` | Self-contained Codex install root |
| `claude/openpocket-phone/` | Self-contained Claude Code install root |
| `*/openpocket-phone/runtime/openpocket-phone-server.mjs` | Generated 23-tool MCP runtime in each host bundle |
| `*/openpocket-phone/runtime/openpocket-ime.apk` | Generated Unicode-safe Android input helper copy |
| `*/openpocket-phone/runtime/screen-awake-worker.js` | Generated screen-awake helper copy |
| `claude/openpocket-phone/releases/openpocket-phone-claude.zip` | Ready-to-upload Claude Desktop artifact |
| `scripts/package.mjs` | Builds once and synchronizes both host bundles |
| `scripts/doctor.mjs` | Validates manifests, shared content hashes, and tool inventory |

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

The package command builds the runtime once in a temporary staging directory, copies it and the canonical skill into both host adapters, and refreshes the Claude Desktop zip.
