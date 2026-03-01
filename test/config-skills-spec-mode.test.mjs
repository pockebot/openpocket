import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { loadConfig } = await import("../dist/config/index.js");

async function withTempHome(prefix, fn) {
  const prevHome = process.env.OPENPOCKET_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.OPENPOCKET_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) {
      delete process.env.OPENPOCKET_HOME;
    } else {
      process.env.OPENPOCKET_HOME = prevHome;
    }
  }
}

test("skillsSpecMode defaults to mixed", async () => {
  await withTempHome("openpocket-skills-mode-default-", async () => {
    const cfg = loadConfig();
    assert.equal(cfg.agent.skillsSpecMode, "mixed");
  });
});

test("skillsSpecMode accepts strict and legacy config values", async () => {
  await withTempHome("openpocket-skills-mode-values-", async (home) => {
    const cfgPath = path.join(home, "config.json");
    fs.writeFileSync(
      cfgPath,
      `${JSON.stringify(
        {
          projectName: "OpenPocket",
          workspaceDir: path.join(home, "workspace"),
          stateDir: path.join(home, "state"),
          defaultModel: "gpt-5.2-codex",
          models: {
            "gpt-5.2-codex": {
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-5.2-codex",
              apiKey: "",
              apiKeyEnv: "OPENAI_API_KEY",
              maxTokens: 1024,
              reasoningEffort: "medium",
              temperature: null,
            },
          },
          agent: {
            skillsSpecMode: "strict",
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const cfgStrict = loadConfig(cfgPath);
    assert.equal(cfgStrict.agent.skillsSpecMode, "strict");

    fs.writeFileSync(
      cfgPath,
      `${JSON.stringify(
        {
          project_name: "OpenPocket",
          workspace_dir: path.join(home, "workspace"),
          state_dir: path.join(home, "state"),
          default_model: "gpt-5.2-codex",
          models: {
            "gpt-5.2-codex": {
              base_url: "https://api.openai.com/v1",
              model: "gpt-5.2-codex",
              api_key: "",
              api_key_env: "OPENAI_API_KEY",
              max_tokens: 1024,
              reasoning_effort: "medium",
              temperature: null,
            },
          },
          agent: {
            skills_spec_mode: "legacy",
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const cfgLegacy = loadConfig(cfgPath);
    assert.equal(cfgLegacy.agent.skillsSpecMode, "legacy");
  });
});

test("skillsSpecMode falls back to mixed for invalid values", async () => {
  await withTempHome("openpocket-skills-mode-invalid-", async (home) => {
    const cfgPath = path.join(home, "config.json");
    fs.writeFileSync(
      cfgPath,
      `${JSON.stringify(
        {
          projectName: "OpenPocket",
          workspaceDir: path.join(home, "workspace"),
          stateDir: path.join(home, "state"),
          defaultModel: "gpt-5.2-codex",
          models: {
            "gpt-5.2-codex": {
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-5.2-codex",
              apiKey: "",
              apiKeyEnv: "OPENAI_API_KEY",
              maxTokens: 1024,
              reasoningEffort: "medium",
              temperature: null,
            },
          },
          agent: {
            skillsSpecMode: "banana",
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.agent.skillsSpecMode, "mixed");
  });
});
