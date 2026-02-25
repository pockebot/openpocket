import assert from "node:assert/strict";
import test from "node:test";

const { buildSystemPrompt, buildUserPrompt } = await import("../dist/agent/prompts.js");

test("buildSystemPrompt includes planning rules and skills", () => {
  const prompt = buildSystemPrompt("- skill-a\n- skill-b");
  assert.match(prompt, /You are OpenPocket, an Android phone-use agent/);
  assert.match(prompt, /Planning Loop/);
  assert.match(prompt, /deterministic action/);
  assert.match(prompt, /Human Authorization Policy/);
  assert.match(prompt, /Available Skills/);
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /Skill Selection Protocol/);
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

test("buildSystemPrompt includes workspace context when provided", () => {
  const prompt = buildSystemPrompt("- skill-a", "### AGENTS.md\nrule A");
  assert.match(prompt, /Workspace Prompt Context/);
  assert.match(prompt, /AGENTS\.md/);
});

test("buildSystemPrompt keeps available-skills index when activeSkillsText is provided", () => {
  const prompt = buildSystemPrompt("- skill-a", "", {
    mode: "full",
    activeSkillsText: "### [workspace] Skill A\nReason: explicit id match\nPath: /tmp/skill-a.md\n# SKILL BODY",
  });
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /Use read\(location\) to load full SKILL.md/i);
  assert.doesNotMatch(prompt, /SKILL BODY/);
});

test("buildSystemPrompt supports minimal mode", () => {
  const prompt = buildSystemPrompt("- skill-a", "### AGENTS.md\nrule A", { mode: "minimal" });
  assert.match(prompt, /Core Rules/);
  assert.match(prompt, /Call exactly one tool per step/);
  assert.match(prompt, /tap Allow locally/i);
  assert.match(prompt, /Use request_user_decision only for non-sensitive preference\/choice disambiguation/i);
  assert.match(prompt, /Use request_user_input for non-sensitive short text values/i);
  assert.match(prompt, /Never use request_user_decision to collect credentials\/OTP\/payment/i);
  assert.match(prompt, /already injected in this prompt/i);
  assert.match(prompt, /Workspace Prompt Context/);
  assert.match(prompt, /Tooling/);
  assert.match(prompt, /tap.*swipe/s);
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
