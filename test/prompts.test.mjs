import assert from "node:assert/strict";
import test from "node:test";

const { buildSystemPrompt, buildUserPrompt } = await import("../dist/agent/prompts.js");

test("buildSystemPrompt includes planning rules and skills", () => {
  const prompt = buildSystemPrompt("- skill-a\n- skill-b");
  assert.match(prompt, /You are OpenPocket, an Android phone-use agent/);
  assert.match(prompt, /Planning Loop/);
  assert.match(prompt, /deterministic action/);
  assert.match(prompt, /Human Authorization Policy/);
  assert.match(prompt, /Device Ownership Model/);
  assert.match(prompt, /Agent Phone/);
  assert.match(prompt, /Human Phone/);
  assert.match(prompt, /Capability must be chosen by the agent/i);
  assert.match(prompt, /Do not apply fixed capability priority/i);
  assert.match(prompt, /Never emit meta labels\/tags in thought/i);
  assert.match(prompt, /Available Skills/);
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /Skill Selection Protocol/);
  assert.match(prompt, /If exactly one skill clearly applies, call read\(location\)/);
  assert.match(prompt, /Memory Recall Protocol/);
  assert.match(prompt, /memory_search/);
  assert.match(prompt, /memory_get/);
  assert.match(prompt, /Write thought and all text fields in English/);
  assert.match(prompt, /Input-focus anti-loop/);
  assert.match(prompt, /Never type internal logs\/history\/JSON/);
  assert.match(prompt, /in-emulator permission dialogs/i);
  assert.match(prompt, /request_user_decision must not be used to collect credentials/i);
  assert.match(prompt, /request_user_input must not be used to collect credentials/i);
  assert.match(prompt, /For sensitive values, call request_human_auth/i);
  assert.match(prompt, /Workspace context .* already injected/i);
  assert.doesNotMatch(
    prompt,
    /If screen requires user-owned account\/personal data, do not guess or invent values; call request_user_decision first\./,
  );
  assert.match(prompt, /skill-a/);
});

test("buildSystemPrompt data-source check doesn't require auth before app launch for login/payment tasks", () => {
  const prompt = buildSystemPrompt("- skill-a", "", { mode: "full" });
  const dataSourceLine = prompt
    .split("\n")
    .find((line) => line.startsWith("0) DATA SOURCE CHECK")) || "";

  assert.ok(dataSourceLine, "Expected a DATA SOURCE CHECK line in full system prompt");
  assert.match(
    dataSourceLine,
    /Human Phone \(photos, contacts, files, audio, location, etc\.\)/,
  );
  assert.match(
    dataSourceLine,
    /launch the target app.*first explicit sensitive prompt/i,
  );
  assert.match(prompt, /call request_human_auth with capability=oauth/i);
});

test("buildSystemPrompt includes workspace context when provided", () => {
  const prompt = buildSystemPrompt("- skill-a", "### AGENTS.md\nrule A");
  assert.match(prompt, /Workspace Prompt Context/);
  assert.match(prompt, /AGENTS\.md/);
});

test("buildSystemPrompt supports explicitly preloaded skill blocks when provided", () => {
  const prompt = buildSystemPrompt("- skill-a", "", {
    mode: "full",
    activeSkillsText: "<active_skill name=\"Skill A\" source=\"workspace\" score=\"120\" reason=\"explicit id match\">\n# SKILL BODY\n</active_skill>",
  });
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /Preloaded Skills/);
  assert.match(prompt, /SKILL BODY/);
  assert.match(prompt, /does not need read\(\)/i);
});

test("buildSystemPrompt supports minimal mode", () => {
  const prompt = buildSystemPrompt("- skill-a", "### AGENTS.md\nrule A", { mode: "minimal" });
  assert.match(prompt, /Core Rules/);
  assert.match(prompt, /Call exactly one tool per step/);
  assert.match(prompt, /tap Allow locally/i);
  assert.match(prompt, /Use request_user_decision only for non-sensitive preference\/choice disambiguation/i);
  assert.match(prompt, /Use request_user_input for non-sensitive short text values/i);
  assert.match(prompt, /Never use request_user_decision to collect credentials\/OTP\/payment/i);
  assert.match(prompt, /Do not use fixed capability priority rules/i);
  assert.match(prompt, /Agent Phone.*clean.*shared/i);
  assert.match(prompt, /Human Phone.*personal/i);
  assert.match(prompt, /request_human_auth/i);
  assert.match(prompt, /already injected in this prompt/i);
  assert.match(prompt, /Workspace Prompt Context/);
  assert.match(prompt, /Tooling/);
  assert.match(prompt, /tap.*swipe/s);
  assert.match(prompt, /drag.*long_press_drag/s);
  assert.doesNotMatch(prompt, /Planning Loop/);
});

test("buildSystemPrompt filters tool catalog when availableToolNames is provided", () => {
  const prompt = buildSystemPrompt("- skill-a", "", {
    mode: "full",
    availableToolNames: ["tap", "launch_app", "finish"],
  });
  assert.match(prompt, /tap: tap/);
  assert.match(prompt, /launch_app: launch_app/);
  assert.match(prompt, /finish: finish/);
  assert.doesNotMatch(prompt, /read: read/);
  assert.doesNotMatch(prompt, /memory_search: memory_search/);
});

test("buildSystemPrompt supports none mode", () => {
  const prompt = buildSystemPrompt("- skill-a", "### AGENTS.md\nrule A", { mode: "none" });
  assert.match(prompt, /Call exactly one tool step at a time/);
  assert.match(prompt, /Agent Phone.*clean.*shared/i);
  assert.match(prompt, /Do not rely on fixed capability priority/i);
  assert.match(prompt, /permission dialogs/i);
  assert.doesNotMatch(prompt, /Workspace Prompt Context/);
  assert.doesNotMatch(prompt, /Available Skills/);
});

test("buildUserPrompt keeps only recent 8 history items", () => {
  const history = Array.from({ length: 12 }, (_, i) => `step-history-${i + 1}`);
  const prompt = buildUserPrompt(
    "check weather",
    5,
    {
      deviceId: "emulator-5554",
      currentApp: "com.android.chrome",
      width: 1080,
      height: 2400,
      capturedAt: new Date().toISOString(),
      screenshotBase64: "abc",
      scaleX: 1,
      scaleY: 1,
      scaledWidth: 1080,
      scaledHeight: 2400,
    },
    history,
  );

  assert.match(prompt, /Task: check weather/);
  assert.match(prompt, /step-history-12/);
  assert.match(prompt, /step-history-5/);
  assert.match(prompt, /Decision checklist/);
  assert.match(prompt, /Runtime stuck signals/);
  assert.match(prompt, /Never type logs\/history\/JSON strings/);
  assert.match(prompt, /Call exactly one tool now/);
  assert.doesNotMatch(prompt, /step-history-1(?!\d)/);
  assert.doesNotMatch(prompt, /step-history-4(?!\d)/);
});

test("buildUserPrompt marks secure surface and omits raw-screenshot guidance", () => {
  const prompt = buildUserPrompt(
    "complete secure checkout",
    2,
    {
      deviceId: "emulator-5554",
      currentApp: "com.shop.app",
      width: 1080,
      height: 2400,
      capturedAt: new Date().toISOString(),
      screenshotBase64: "abc",
      secureSurfaceDetected: true,
      secureSurfaceEvidence: "FLAG_SECURE in focused window",
      scaleX: 1,
      scaleY: 1,
      scaledWidth: 1080,
      scaledHeight: 2400,
      uiElements: [],
      somScreenshotBase64: null,
    },
    [],
  );

  assert.match(prompt, /secure_surface_detected: true/);
  assert.match(prompt, /secure_surface_ui_candidates_empty: true/);
  assert.match(prompt, /FLAG_SECURE in focused window/);
  assert.match(prompt, /Raw screenshot is intentionally omitted/i);
});
