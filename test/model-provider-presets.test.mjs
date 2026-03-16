import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  buildModelProfileFromPreset,
  resolveModelProviderPreset,
  resolveModelProviderPresetByBaseUrl,
} = await import("../dist/config/model-provider-presets.js");
const { loadConfig } = await import("../dist/config/index.js");

test("Aliyun UI Agent preset builds a mobile backend profile", () => {
  const preset = resolveModelProviderPreset("aliyun-ui-agent");
  assert.ok(preset);
  assert.equal(preset.baseUrl, "https://dashscope.aliyuncs.com/api/v2/apps/gui-owl/gui_agent_server");
  assert.equal(preset.apiKeyEnv, "DASHSCOPE_API_KEY");

  const profile = buildModelProfileFromPreset(preset, "pre-gui_owl_7b");
  assert.equal(profile.backend, "aliyun_ui_agent_mobile");
  assert.equal(profile.baseUrl, preset.baseUrl);
  assert.equal(profile.model, "pre-gui_owl_7b");
  assert.equal(profile.apiKeyEnv, "DASHSCOPE_API_KEY");
});

test("DashScope preset resolution distinguishes UI Agent from compatible mode", () => {
  const uiAgentPreset = resolveModelProviderPresetByBaseUrl(
    "https://dashscope.aliyuncs.com/api/v2/apps/gui-owl/gui_agent_server",
  );
  const compatibleModePreset = resolveModelProviderPresetByBaseUrl(
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  const bareHostPreset = resolveModelProviderPresetByBaseUrl(
    "https://dashscope.aliyuncs.com",
  );

  assert.equal(uiAgentPreset?.key, "aliyun-ui-agent");
  assert.equal(compatibleModePreset?.key, "qwen");
  assert.equal(bareHostPreset?.key, "qwen");
});

test("loadConfig preserves explicit Aliyun UI Agent backend hints", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openpocket-aliyun-ui-agent-config-"));
  const configPath = path.join(tmpDir, "config.json");

  fs.writeFileSync(configPath, JSON.stringify({
    defaultModel: "aliyun-ui-agent/pre-gui_owl_7b",
    models: {
      "aliyun-ui-agent/pre-gui_owl_7b": {
        baseUrl: "https://dashscope.aliyuncs.com/api/v2/apps/gui-owl/gui_agent_server",
        model: "pre-gui_owl_7b",
        apiKeyEnv: "DASHSCOPE_API_KEY",
        backend: "aliyun_ui_agent_mobile",
      },
    },
  }, null, 2));

  const config = loadConfig(configPath);
  assert.equal(config.models["aliyun-ui-agent/pre-gui_owl_7b"]?.backend, "aliyun_ui_agent_mobile");
});
