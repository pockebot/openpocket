# Strict Agent Skills Compatibility + Auto-Skill Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate OpenPocket to strict Agent Skills-compatible loading/writing, and add a two-stage auto-skill pipeline (`draft -> AI refine -> validate -> promote`).

**Architecture:** Keep current runtime behavior stable while introducing `agent.skillsSpecMode` (`legacy | mixed | strict`) as a migration safety rail. In strict mode, only directory-based `SKILL.md` is valid, frontmatter validation is mandatory, and auto-generated skills are emitted as spec-compliant skill directories. Auto-skill generation remains deterministic for draft creation, then a refinement step uses a dedicated authoring skill plus strict validator gating before promotion.

**Tech Stack:** TypeScript (Node.js 20+), existing OpenPocket runtime (`src/agent/runtime/*`), Node test runner (`node --test`), current config system (`src/config/index.ts`).

## Non-Goals

- No immediate hard break for existing users on day one (use `mixed` mode rollout first).
- No marketplace/distribution changes beyond local skill format compatibility.
- No new external service dependency for validation.

### Task 1: Add Skills Spec Mode (Feature Flag)

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config/index.ts`
- Modify: `openpocket.config.example.json`
- Test: `test/config-skills-spec-mode.test.mjs`

**Step 1: Write the failing test**

Add tests asserting:
- default mode is `mixed`
- config accepts `legacy | mixed | strict`
- invalid value falls back to `mixed` with warning path

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/config-skills-spec-mode.test.mjs`  
Expected: FAIL (field does not exist yet).

**Step 3: Write minimal implementation**

- Add `skillsSpecMode` to agent config type.
- Parse value in config loader with safe normalization.
- Add example config key:
  - `"skillsSpecMode": "mixed"`

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/config-skills-spec-mode.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/types.ts src/config/index.ts openpocket.config.example.json test/config-skills-spec-mode.test.mjs
git commit -m "feat(config): add skillsSpecMode for skills format rollout"
```

### Task 2: Introduce Strict Skill Spec Validator

**Files:**
- Create: `src/skills/spec-validator.ts`
- Test: `test/skills-spec-validator.test.mjs`

**Step 1: Write the failing test**

Cover at least:
- valid `SKILL.md` with YAML frontmatter passes
- missing frontmatter fails
- missing `name`/`description` fails
- parent directory and `name` mismatch fails (strict mode)

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/skills-spec-validator.test.mjs`  
Expected: FAIL (module missing).

**Step 3: Write minimal implementation**

Implement validator API returning structured issues:
- `validateSkillDocument(content, { strict: true })`
- `validateSkillPath(path, { strict: true })`
- stable issue codes (for CLI and logs)

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/skills-spec-validator.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/skills/spec-validator.ts test/skills-spec-validator.test.mjs
git commit -m "feat(skills): add strict Agent Skills validator"
```

### Task 3: Enforce Strict Discovery Rules in Skill Loader

**Files:**
- Modify: `src/skills/skill-loader.ts`
- Test: `test/skills-loader-strict-mode.test.mjs`

**Step 1: Write the failing test**

Assert in `strict` mode:
- only `*/SKILL.md` is discovered
- raw `*.md` files are ignored
- invalid skill directories are excluded with reason

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/skills-loader-strict-mode.test.mjs`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Gate discovery by `skillsSpecMode`.
- In `strict`, require `SKILL.md` and validator pass.
- In `mixed`, accept legacy files but mark non-compliant entries.

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/skills-loader-strict-mode.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/skills/skill-loader.ts test/skills-loader-strict-mode.test.mjs
git commit -m "feat(skills): enforce strict SKILL.md discovery mode"
```

### Task 4: Add Progressive Disclosure-Compatible Skill Loading

**Files:**
- Modify: `src/skills/skill-loader.ts`
- Test: `test/skills-loader-progressive-disclosure.test.mjs`

**Step 1: Write the failing test**

Assert:
- initial selection/scoring does not require full body load
- active skill content is loaded only for selected entries

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/skills-loader-progressive-disclosure.test.mjs`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Split metadata index loading and full content hydration.
- Keep existing scoring behavior where possible, but avoid heavy body reads before selection.

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/skills-loader-progressive-disclosure.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/skills/skill-loader.ts test/skills-loader-progressive-disclosure.test.mjs
git commit -m "refactor(skills): add progressive disclosure loading flow"
```

### Task 5: Make Auto Artifact Output Spec-Compliant

**Files:**
- Modify: `src/skills/auto-artifact-builder.ts`
- Test: `test/auto-artifact-builder.test.mjs`

**Step 1: Write the failing test**

Assert in `strict` mode:
- generated path is `.../skills/auto/<skill-id>/SKILL.md`
- frontmatter includes required fields
- draft metadata is explicit (`status=draft` equivalent)

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/auto-artifact-builder.test.mjs`  
Expected: FAIL on path/format mismatch.

**Step 3: Write minimal implementation**

- Keep deterministic draft generation.
- Change disk layout for strict mode to directory + `SKILL.md`.
- Preserve backward-compatible output in legacy/mixed if needed.

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/auto-artifact-builder.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/skills/auto-artifact-builder.ts test/auto-artifact-builder.test.mjs
git commit -m "feat(auto-skill): emit spec-compliant SKILL.md directories"
```

### Task 6: Add Skill Authoring Guidance Skill for Refinement Stage

**Files:**
- Create: `skills/skill-authoring/SKILL.md`
- Create: `src/skills/auto-skill-refiner.ts`
- Test: `test/auto-skill-refiner.test.mjs`

**Step 1: Write the failing test**

Assert:
- refiner consumes draft skill
- produces candidate with required frontmatter + clearer trigger/preconditions/failure branches
- validator pass required for promotion

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/auto-skill-refiner.test.mjs`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Add a dedicated authoring prompt contract in `skill-authoring` skill.
- Implement `AutoSkillRefiner.refine(draftPath, context)` returning `{ promotedPath | null, issues[] }`.

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/auto-skill-refiner.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add skills/skill-authoring/SKILL.md src/skills/auto-skill-refiner.ts test/auto-skill-refiner.test.mjs
git commit -m "feat(auto-skill): add AI refinement stage with authoring skill"
```

### Task 7: Wire Draft -> Refine -> Validate -> Promote in Runtime

**Files:**
- Modify: `src/agent/runtime/attempt.ts`
- Modify: `src/agent/runtime/types.ts`
- Modify: `src/types.ts`
- Test: `test/agent-runtime-auto-skill-pipeline.test.mjs`

**Step 1: Write the failing test**

Assert success path:
- draft created
- refine attempted
- invalid refined skill stays draft
- valid refined skill promoted and returned in result

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/agent-runtime-auto-skill-pipeline.test.mjs`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- After successful task, run refiner (guarded by config).
- Add clear runtime logs:
  - draft created
  - refine pass/fail reason
  - promoted path
- Extend `AgentRunResult` payload for refined skill visibility if needed.

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/agent-runtime-auto-skill-pipeline.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/runtime/attempt.ts src/agent/runtime/types.ts src/types.ts test/agent-runtime-auto-skill-pipeline.test.mjs
git commit -m "feat(runtime): add auto skill promotion pipeline with validation gate"
```

### Task 8: Add Validation + Migration CLI and Docs

**Files:**
- Modify: `src/cli.ts`
- Create: `scripts/migrate-skills-to-spec.mjs`
- Modify: `frontend/tools/skills.md`
- Modify: `README.md`
- Test: `test/cli-skills-validate.test.mjs`

**Step 1: Write the failing test**

Assert:
- `openpocket skills validate --strict` exits non-zero on invalid skills
- summary includes counts (`valid/invalid/warn`)

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/cli-skills-validate.test.mjs`  
Expected: FAIL.

**Step 3: Write minimal implementation**

- Add CLI validation command.
- Add migration helper script for legacy `*.md` -> `dir/SKILL.md`.
- Document strict/mixed/legacy rollout and auto-skill promotion pipeline.

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/cli-skills-validate.test.mjs`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/cli.ts scripts/migrate-skills-to-spec.mjs frontend/tools/skills.md README.md test/cli-skills-validate.test.mjs
git commit -m "feat(cli): add strict skills validation and migration tooling"
```

## Final Verification

Run:

```bash
npm run test
```

Expected:
- all existing tests pass
- new strict-mode and pipeline tests pass
- no regression in legacy mode behavior

## Rollout Plan

1. Release with `skillsSpecMode="mixed"` default and warnings for non-compliant skills.
2. Publish migration guide + CLI validator.
3. After one release cycle, switch default to `strict`.
4. Keep `legacy` fallback one additional cycle, then deprecate.

## Risks and Mitigations

- Risk: Legacy user skills stop loading unexpectedly.  
Mitigation: Keep mixed default first, add explicit warnings and migration command.

- Risk: Refinement model produces invalid YAML/frontmatter.  
Mitigation: strict validator gate + never promote invalid output.

- Risk: Runtime latency increase due to refine stage.  
Mitigation: refine only on successful tasks and keep configurable toggle.

Plan complete and saved to `docs/plans/2026-02-28-strict-agentskills-compatibility-and-auto-skill-refinement.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
