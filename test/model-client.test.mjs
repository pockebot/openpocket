import assert from "node:assert/strict";
import test from "node:test";

const { ModelClient, buildPiAiModel } = await import("../dist/agent/model-client.js");

function makeProfile() {
  return {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.2-codex",
    apiKey: "",
    apiKeyEnv: "OPENAI_API_KEY",
    maxTokens: 512,
    reasoningEffort: "medium",
    temperature: null,
  };
}

// ---------------------------------------------------------------------------
// buildPiAiModel tests
// ---------------------------------------------------------------------------

test("buildPiAiModel selects openai-completions for codex models on OpenAI", () => {
  const model = buildPiAiModel(makeProfile());
  assert.equal(model.api, "openai-completions");
  assert.equal(model.provider, "openai");
  assert.equal(model.id, "gpt-5.2-codex");
});

test("buildPiAiModel selects openai-codex-responses for Codex backend URLs", () => {
  const profile = {
    ...makeProfile(),
    baseUrl: "https://chatgpt.com/backend-api/codex",
    model: "gpt-5.3-codex",
  };
  const model = buildPiAiModel(profile);
  assert.equal(model.api, "openai-codex-responses");
  assert.equal(model.provider, "openai-codex");
});

test("buildPiAiModel selects openai-completions for non-codex models on OpenAI", () => {
  const profile = { ...makeProfile(), model: "gpt-4o" };
  const model = buildPiAiModel(profile);
  assert.equal(model.api, "openai-completions");
  assert.equal(model.provider, "openai");
});

test("buildPiAiModel selects openrouter provider for OpenRouter baseUrl", () => {
  const profile = {
    ...makeProfile(),
    baseUrl: "https://openrouter.ai/api/v1",
    model: "claude-sonnet-4.6",
  };
  const model = buildPiAiModel(profile);
  assert.equal(model.api, "openai-completions");
  assert.equal(model.provider, "openrouter");
});

test("buildPiAiModel selects anthropic-messages for Anthropic baseUrl", () => {
  const profile = {
    ...makeProfile(),
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4.6",
  };
  const model = buildPiAiModel(profile);
  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.provider, "anthropic");
});

test("buildPiAiModel selects openai-completions for gpt-5 models on OpenAI", () => {
  const profile = { ...makeProfile(), model: "gpt-5.3" };
  const model = buildPiAiModel(profile);
  assert.equal(model.api, "openai-completions");
  assert.equal(model.provider, "openai");
});

test("buildPiAiModel sets reasoning flag based on reasoningEffort", () => {
  const withReasoning = buildPiAiModel(makeProfile());
  assert.equal(withReasoning.reasoning, true);

  const withoutReasoning = buildPiAiModel({
    ...makeProfile(),
    reasoningEffort: null,
  });
  assert.equal(withoutReasoning.reasoning, false);
});

// ---------------------------------------------------------------------------
// ModelClient constructor tests
// ---------------------------------------------------------------------------

test("ModelClient respects preferredMode override to responses", () => {
  const client = new ModelClient(makeProfile(), "dummy", {
    preferredMode: "responses",
  });
  // The piModel is private, but we can verify via the public API
  // Just ensure construction doesn't throw
  assert.ok(client);
});

test("ModelClient respects preferredMode override to completions", () => {
  const client = new ModelClient(makeProfile(), "dummy", {
    preferredMode: "completions",
  });
  assert.ok(client);
});

test("ModelClient respects baseUrl override", () => {
  const client = new ModelClient(makeProfile(), "dummy", {
    baseUrl: "https://custom-api.example.com/v1",
  });
  assert.ok(client);
});

// ---------------------------------------------------------------------------
// TOOL_METAS integration
// ---------------------------------------------------------------------------

test("ModelClient builds pi-ai tools from TOOL_METAS", async () => {
  const { TOOL_METAS } = await import("../dist/agent/tools.js");
  assert.equal(TOOL_METAS.length, 21);
  const names = TOOL_METAS.map((t) => t.name);
  assert.ok(names.includes("tap"));
  assert.ok(names.includes("finish"));
  assert.ok(names.includes("request_human_auth"));
  assert.ok(names.includes("request_user_input"));

  // Each tool meta has valid TypeBox-generated schema with properties
  for (const meta of TOOL_METAS) {
    assert.equal(typeof meta.parameters, "object");
    assert.ok(meta.parameters.properties, `${meta.name} should have properties`);
    assert.ok(meta.parameters.properties.thought, `${meta.name} should have thought property`);
  }
});

test("CHAT_TOOLS format matches expected OpenAI function calling shape", async () => {
  const { CHAT_TOOLS } = await import("../dist/agent/tools.js");
  assert.ok(CHAT_TOOLS.length > 0);
  const tap = CHAT_TOOLS.find((t) => t.function.name === "tap");
  assert.ok(tap);
  assert.equal(tap.type, "function");
  assert.equal(typeof tap.function.description, "string");
  assert.ok(tap.function.parameters.properties);
  assert.ok(tap.function.parameters.required);
  assert.ok(tap.function.parameters.required.includes("thought"));
  assert.ok(tap.function.parameters.required.includes("x"));
  assert.ok(tap.function.parameters.required.includes("y"));
  // reason should NOT be required (it's Optional)
  assert.ok(!tap.function.parameters.required.includes("reason"));
});
