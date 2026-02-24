import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  loadConfig,
  saveConfig,
  getModelProfile,
  resolveApiKey,
  resolveModelAuth,
} = await import("../dist/config/index.js");

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

async function withTempCodexHome(prefix, fn) {
  const prevCodexHome = process.env.CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.CODEX_HOME = codexHome;
  try {
    return await fn(codexHome);
  } finally {
    if (prevCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prevCodexHome;
    }
  }
}

test("loadConfig creates defaults including returnHomeOnTaskEnd", async () => {
  await withTempHome("openpocket-config-default-", async (home) => {
    const cfg = loadConfig();
    assert.equal(cfg.sessionStorage.mode, "unified");
    assert.equal(cfg.sessionStorage.markdownLog, true);
    assert.match(cfg.sessionStorage.storePath, /workspace[\\/]+sessions[\\/]sessions\.json$/);
    assert.equal(cfg.agent.returnHomeOnTaskEnd, true);
    assert.equal(cfg.agent.systemPromptMode, "full");
    assert.equal(cfg.agent.contextBudgetChars, 150_000);
    assert.equal(cfg.memoryTools.enabled, true);
    assert.equal(cfg.memoryTools.maxResults, 6);
    assert.equal(cfg.memoryTools.minScore, 0.2);
    assert.equal(cfg.memoryTools.maxSnippetChars, 1200);
    assert.equal(cfg.humanAuth.enabled, false);
    assert.equal(cfg.humanAuth.useLocalRelay, true);
    assert.equal(cfg.humanAuth.localRelayPort, 8787);
    assert.equal(cfg.humanAuth.tunnel.provider, "none");
    assert.equal(cfg.humanAuth.requestTimeoutSec, 300);
    assert.equal(cfg.dashboard.enabled, true);
    assert.equal(cfg.dashboard.host, "127.0.0.1");
    assert.equal(cfg.dashboard.port, 51888);
    assert.equal(cfg.dashboard.autoOpenBrowser, false);
    assert.equal(cfg.heartbeat.enabled, true);
    assert.equal(cfg.cron.enabled, true);
    assert.equal(cfg.emulator.dataPartitionSizeGb, 24);
    assert.deepEqual(cfg.emulator.extraArgs, []);
    assert.equal(fs.existsSync(path.join(home, "config.json")), true);
    assert.equal(fs.existsSync(cfg.workspaceDir), true);
    assert.equal(fs.existsSync(cfg.stateDir), true);
    assert.equal(fs.existsSync(cfg.screenshots.directory), true);
    assert.equal(fs.existsSync(path.join(cfg.workspaceDir, "cron", "jobs.json")), true);
  });
});

test("loadConfig migrates legacy snake_case return_home_on_task_end", async () => {
  await withTempHome("openpocket-config-migrate-", async (home) => {
    const cfgPath = path.join(home, "config.json");
    fs.writeFileSync(
      cfgPath,
      `${JSON.stringify(
        {
          project_name: "OpenPocket",
          workspace_dir: path.join(home, "workspace"),
          state_dir: path.join(home, "state"),
          session_storage: {
            storage_backend: "markdown",
            dual_write_jsonl: true,
          },
          default_model: "gpt-5.2-codex",
          emulator: {
            avd_name: "TestAVD",
            data_partition_size_gb: 48,
            extra_args: ["-accel", "off"],
          },
          telegram: {},
          agent: {
            max_steps: 10,
            return_home_on_task_end: false,
            system_prompt_mode: "minimal",
            context_budget_chars: 30000,
            verbose: true,
          },
          models: {
            "gpt-5.2-codex": {
              base_url: "https://api.openai.com/v1",
              model: "gpt-5.2-codex",
              api_key: "",
              api_key_env: "OPENAI_API_KEY",
              max_tokens: 1024,
              reasoning_effort: "medium",
            },
          },
          human_auth: {
            enabled: true,
            use_local_relay: true,
            local_relay_host: "127.0.0.1",
            local_relay_port: 9898,
            relay_base_url: "https://relay.example.com",
            request_timeout_sec: 420,
            poll_interval_ms: 1500,
            tunnel: {
              provider_type: "ngrok",
              ngrok: {
                enabled: true,
                auth_token_env: "NGROK_AUTHTOKEN",
                startup_timeout_sec: 33,
              },
            },
          },
          dashboard_config: {
            enabled: true,
            host: "0.0.0.0",
            port: 51999,
            auto_open_browser: true,
          },
          memory_tools: {
            enabled: true,
            max_results: 12,
            min_score: 0.35,
            max_snippet_chars: 2048,
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const cfg = loadConfig();
    assert.equal(cfg.sessionStorage.mode, "unified");
    assert.equal(cfg.sessionStorage.markdownLog, true);
    assert.match(cfg.sessionStorage.storePath, /workspace[\\/]+sessions[\\/]sessions\.json$/);
    assert.equal(cfg.agent.returnHomeOnTaskEnd, false);
    assert.equal(cfg.agent.systemPromptMode, "minimal");
    assert.equal(cfg.agent.contextBudgetChars, 30000);
    assert.equal(cfg.emulator.dataPartitionSizeGb, 48);
    assert.deepEqual(cfg.emulator.extraArgs, ["-accel", "off"]);
    assert.equal(cfg.humanAuth.enabled, true);
    assert.equal(cfg.humanAuth.relayBaseUrl, "https://relay.example.com");
    assert.equal(cfg.humanAuth.localRelayPort, 9898);
    assert.equal(cfg.humanAuth.requestTimeoutSec, 420);
    assert.equal(cfg.humanAuth.tunnel.provider, "ngrok");
    assert.equal(cfg.humanAuth.tunnel.ngrok.enabled, true);
    assert.equal(cfg.humanAuth.tunnel.ngrok.authtokenEnv, "NGROK_AUTHTOKEN");
    assert.equal(cfg.humanAuth.tunnel.ngrok.startupTimeoutSec, 33);
    assert.equal(cfg.dashboard.enabled, true);
    assert.equal(cfg.dashboard.host, "0.0.0.0");
    assert.equal(cfg.dashboard.port, 51999);
    assert.equal(cfg.dashboard.autoOpenBrowser, true);
    assert.equal(cfg.memoryTools.enabled, true);
    assert.equal(cfg.memoryTools.maxResults, 12);
    assert.equal(cfg.memoryTools.minScore, 0.35);
    assert.equal(cfg.memoryTools.maxSnippetChars, 2048);

    saveConfig(cfg);
    const saved = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    assert.equal(saved.sessionStorage.mode, "unified");
    assert.equal(saved.sessionStorage.markdownLog, true);
    assert.match(String(saved.sessionStorage.storePath ?? ""), /workspace[\\/]+sessions[\\/]sessions\.json$/);
    assert.equal(saved.session_storage, undefined);
    assert.equal(saved.agent.returnHomeOnTaskEnd, false);
    assert.equal(saved.agent.systemPromptMode, "minimal");
    assert.equal(saved.agent.contextBudgetChars, 30000);
    assert.equal(saved.agent.return_home_on_task_end, undefined);
    assert.equal(saved.emulator.dataPartitionSizeGb, 48);
    assert.deepEqual(saved.emulator.extraArgs, ["-accel", "off"]);
    assert.equal(saved.emulator.extra_args, undefined);
    assert.equal(saved.humanAuth.relayBaseUrl, "https://relay.example.com");
    assert.equal(saved.humanAuth.localRelayPort, 9898);
    assert.equal(saved.humanAuth.tunnel.provider, "ngrok");
    assert.equal(saved.human_auth, undefined);
    assert.equal(saved.memoryTools.maxResults, 12);
    assert.equal(saved.memory_tools, undefined);
  });
});

test("loadConfig normalizes agent.lang to en", async () => {
  await withTempHome("openpocket-config-lang-", async (home) => {
    const cfgPath = path.join(home, "config.json");
    fs.writeFileSync(
      cfgPath,
      `${JSON.stringify(
        {
          projectName: "OpenPocket",
          workspaceDir: path.join(home, "workspace"),
          stateDir: path.join(home, "state"),
          defaultModel: "gpt-5.2-codex",
          emulator: {},
          telegram: {},
          agent: {
            lang: "zh",
          },
          models: {
            "gpt-5.2-codex": {
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-5.2-codex",
              apiKey: "",
              apiKeyEnv: "OPENAI_API_KEY",
              maxTokens: 1024,
              reasoningEffort: "medium",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.agent.lang, "en");

    saveConfig(cfg);
    const saved = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    assert.equal(saved.agent.lang, "en");
  });
});

test("getModelProfile and resolveApiKey follow precedence rules", async () => {
  await withTempHome("openpocket-config-key-", async (home) => {
    await withTempCodexHome("openpocket-codex-empty-", async () => {
      const cfg = loadConfig(path.join(home, "config.json"));
      const profile = getModelProfile(cfg, cfg.defaultModel);
      assert.equal(profile.model.length > 0, true);

      const prev = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "  env-key  ";
      try {
        assert.equal(
          resolveApiKey({ ...profile, apiKey: " local-key ", apiKeyEnv: "OPENAI_API_KEY" }),
          "local-key",
        );
        assert.equal(resolveApiKey({ ...profile, apiKey: "", apiKeyEnv: "OPENAI_API_KEY" }), "env-key");
        assert.equal(resolveApiKey({ ...profile, apiKey: "", apiKeyEnv: "MISSING_ENV" }), "");
      } finally {
        if (prev === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = prev;
        }
      }
    });
  });
});

test("resolveModelAuth falls back to Codex CLI auth.json for codex models", async () => {
  await withTempHome("openpocket-config-codex-fallback-", async (home) => {
    await withTempCodexHome("openpocket-codex-auth-", async (codexHome) => {
      const cfg = loadConfig(path.join(home, "config.json"));
      const profile = getModelProfile(cfg, "gpt-5.2-codex");
      const authPath = path.join(codexHome, "auth.json");
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          tokens: {
            access_token: "codex-access-token",
            refresh_token: "codex-refresh-token",
          },
        }),
        "utf-8",
      );

      const prevOpenAi = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        const resolved = resolveModelAuth({
          ...profile,
          apiKey: "",
          apiKeyEnv: "OPENAI_API_KEY",
        });

        assert.equal(resolved?.apiKey, "codex-access-token");
        assert.match(String(resolved?.source ?? ""), /codex-cli/i);
        assert.equal(resolved?.preferredMode, "responses");
        assert.match(String(resolved?.baseUrl ?? ""), /chatgpt\.com\/backend-api\/codex/i);
      } finally {
        if (prevOpenAi === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = prevOpenAi;
        }
      }
    });
  });
});

test("resolveModelAuth does not use Codex CLI fallback for non-codex models", async () => {
  await withTempCodexHome("openpocket-codex-auth-noncodex-", async (codexHome) => {
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "codex-access-token",
          refresh_token: "codex-refresh-token",
        },
      }),
      "utf-8",
    );

    const resolved = resolveModelAuth({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKey: "",
      apiKeyEnv: "MISSING_ENV",
      maxTokens: 512,
      reasoningEffort: null,
      temperature: null,
    });

    assert.equal(resolved, null);
  });
});

test("getModelProfile throws on unknown profile", async () => {
  await withTempHome("openpocket-config-unknown-", async () => {
    const cfg = loadConfig();
    assert.throws(() => getModelProfile(cfg, "unknown-model"), /Unknown model profile/);
  });
});
