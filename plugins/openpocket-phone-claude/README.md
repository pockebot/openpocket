# OpenPocket Phone For Claude Code

This directory is the native Claude Code plugin package for OpenPocket Phone. It contains a `phone-use` skill and a bundled MCP runtime with 23 Android tools.

The ready-to-upload Desktop archive is:

```text
releases/openpocket-phone-claude.zip
```

Upload that file from Claude Desktop under **Settings > Plugins > Add > Upload plugin**. Start a new Claude Code task after installation, then ask:

```text
Use OpenPocket Phone. Call target_status and report the Android target.
```

Requirements:

- Node.js 20 or newer
- Android SDK platform-tools
- an emulator AVD or an ADB-authorized Android device

OpenPocket uses `~/.openpocket/config.json`. If it does not exist, the plugin creates an emulator-first default on first launch.

For CLI development, load either the directory or the zip:

```bash
claude --plugin-dir ./plugins/openpocket-phone-claude
claude --plugin-dir ./plugins/openpocket-phone-claude/releases/openpocket-phone-claude.zip
```

Rebuild the self-contained runtime and archive from the repository root:

```bash
npm run phone-use:package:claude
```
