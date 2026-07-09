# OpenPocket Phone For Codex

This directory is the self-contained Codex adapter for the OpenPocket Phone integration. Codex loads the manifest, `phone-use` skill, and bundled 23-tool MCP runtime from this install root.

The adapter is generated from the shared integration at `plugins/openpocket-phone/`; it is not a separate phone-control implementation.

## Install

From the OpenPocket repository root:

```bash
npm run phone-use:install -- codex --target emulator
```

Codex Desktop users can instead open the repository, choose the `OpenPocket Local` marketplace in Plugins, and install **OpenPocket Phone** without building the repository.

Start a new Codex task after installing or updating the plugin, then ask:

```text
Use OpenPocket Phone. Call target_status and report the Android target.
```

## Package Layout

| Path | Purpose |
| --- | --- |
| `.codex-plugin/plugin.json` | Codex plugin manifest and interface metadata |
| `.mcp.json` | Plugin-scoped stdio MCP registration |
| `skills/phone-use/SKILL.md` | Generated copy of the shared phone-use workflow |
| `runtime/openpocket-phone-server.mjs` | Self-contained 23-tool MCP runtime |
| `runtime/openpocket-ime.apk` | Unicode-safe Android input helper |
| `runtime/screen-awake-worker.js` | Screen-awake helper |

Do not edit generated skill or runtime files in this directory directly. Update the canonical skill or MCP source, then run:

```bash
npm run phone-use:package
node plugins/openpocket-phone/scripts/doctor.mjs
```

For screenshots, Claude installation, target setup, and troubleshooting, see the [OpenPocket Phone integration guide](https://github.com/pockebot/openpocket/blob/main/plugins/openpocket-phone/README.md).
