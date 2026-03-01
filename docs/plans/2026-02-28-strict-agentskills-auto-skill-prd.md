# PRD: Strict Agent Skills Compatibility + Auto Skill Refinement

## Document Control

- Date: 2026-02-28
- Status: Draft for implementation kickoff
- Owner: OpenPocket runtime team
- Related design/plan:
  - `docs/plans/2026-02-28-strict-agentskills-compatibility-and-auto-skill-refinement.md`

## 1) Problem Statement

OpenPocket currently supports a flexible skills format, but it is not strictly aligned with the Agent Skills specification model. At the same time, auto-generated skills are useful but remain draft-quality artifacts that are not consistently structured for long-term reuse.

This creates three product problems:

1. Interoperability gap: importing/exporting skills across Agent Skills ecosystems is unreliable.
2. Quality gap: generated skills are often useful but need manual cleanup before trusted reuse.
3. Governance gap: there is no strict validation gate to prevent malformed or weak skills from being promoted.

## 2) Product Goal

Deliver a strict compatibility mode for skills and a reliable auto-skill pipeline that converts successful task traces into validated, reusable skill assets.

Success means:

- OpenPocket can run in a strict Agent Skills-compatible mode.
- Auto-generated skills follow a deterministic draft format, then pass an explicit refinement + validation gate before promotion.
- Teams can audit and migrate existing skills with first-party CLI support.

## 3) Scope

### In Scope

1. Configurable spec modes: `legacy | mixed | strict`.
2. Strict loader behavior in `strict` mode:
   - only directory-based `SKILL.md`
   - required frontmatter validation
   - directory/name consistency checks
3. Auto-skill output upgrade:
   - emit spec-compliant skill directory layout in strict mode
4. Auto-skill quality pipeline:
   - stage A: deterministic draft generation
   - stage B: AI-assisted refinement using a dedicated skill-authoring guide
   - stage C: strict validator gate
   - stage D: promote on pass, keep as draft on fail
5. CLI tooling:
   - strict validation command
   - legacy-to-spec migration helper
6. Documentation updates for operators and contributors.

### Out of Scope

1. Public marketplace/distribution service for skills.
2. Cross-repo remote skill registry.
3. Full historical auto-skill backfill in this release.

## 4) Primary Users

1. Runtime operator (self-hosted user):
   - wants reliable reusable skills without reading raw traces.
2. Contributor/maintainer:
   - wants predictable format, lintable rules, and safe migration.
3. Agent runtime itself:
   - needs high-confidence active skills with fewer malformed entries.

## 5) Current State vs Target State

### Current State

- Skills can be loaded from mixed markdown patterns.
- Frontmatter is loosely optional.
- Auto skills are generated as draft markdown artifacts.
- Validation is soft and format drift is possible.

### Target State

- Strict mode enforces Agent Skills-compatible structure and metadata contract.
- Auto skills are promoted only after passing refinement and strict validation.
- Migration path exists for existing legacy skill files.

## 6) Product Requirements

### PR-1: Skills Spec Mode

- System must support `agent.skillsSpecMode` with values:
  - `legacy`
  - `mixed` (default rollout mode)
  - `strict`
- Invalid values must not crash runtime; fallback behavior must be explicit and observable.

### PR-2: Strict Skill Discovery

- In `strict` mode, runtime must discover skills only from `*/SKILL.md` layout.
- Raw loose `*.md` files must not be treated as valid skills in strict mode.

### PR-3: Strict Validation Gate

- In `strict` mode, every discovered skill must pass validation before load.
- Validation output must be machine-readable (stable error codes/messages).

### PR-4: Auto Skill Draft + Refine Pipeline

- Successful task completion can generate draft skill artifacts.
- Refiner stage must produce a candidate skill using a dedicated authoring guideline.
- Candidate skill must pass strict validation before promotion.
- Validation failure must not break task success; failed candidates remain draft.

### PR-5: Compatibility + Migration Tooling

- CLI command to validate all skills under current mode and strict mode.
- CLI migration helper for legacy layout to strict layout.
- Documentation must explain migration and operational rollout.

## 7) Non-Functional Requirements

1. Safety:
   - No runtime crash due to malformed skills.
   - Promotion pipeline must be fail-closed (invalid skill cannot auto-promote).
2. Backward compatibility:
   - `mixed` mode should preserve current usability during migration window.
3. Observability:
   - Runtime logs and command output should reveal draft/refine/validate/promote outcomes.
4. Performance:
   - Skill loading and validation should keep startup latency acceptable for local runtime.

## 8) UX / Operator Experience

1. Operators can see:
   - whether strict mode is enabled
   - how many skills are valid/invalid
   - why a skill failed validation
2. Operators can run:
   - a strict validation command before deployment
   - a migration helper to convert old format
3. Operators can inspect:
   - draft skills (not promoted)
   - promoted skills (strict-valid)

## 9) Success Metrics

### Launch Metrics

1. Strict validator pass rate on bundled/workspace skills.
2. Percentage of successful tasks producing draft skills.
3. Percentage of draft skills that pass refinement + validation and get promoted.

### Quality Metrics

1. Active-skill load errors per 100 tasks.
2. Manual edits required per promoted skill (target downward trend).
3. Reuse rate of promoted skills in future matched tasks.

## 10) Rollout Strategy

1. Phase 1: Ship with default `mixed`.
   - strict checks available via CLI and logs.
2. Phase 2: Encourage migration; monitor invalid-rate trends.
3. Phase 3: switch default to `strict` after compatibility threshold is met.
4. Phase 4: deprecate `legacy` mode after one additional release cycle.

## 11) Risks and Mitigations

1. Risk: existing user skills stop loading after strict switch.
   - Mitigation: mixed-by-default rollout + validator + migration CLI.
2. Risk: AI refinement outputs malformed skill metadata.
   - Mitigation: strict validator gate; invalid output remains draft.
3. Risk: operator confusion around modes.
   - Mitigation: explicit docs, CLI status output, config examples.

## 12) Open Questions

1. Should strict mode enforce additional metadata fields (for example license/compatibility) from day one or phase in later?
2. Should promoted auto skills live under a separate namespace (`skills/promoted/*`) or stay inside `skills/auto/*` with status markers?
3. What is the acceptable latency budget for refinement on low-end local hardware?

## 13) Acceptance Criteria (Release Gate)

1. `skillsSpecMode` is fully wired and tested for `legacy|mixed|strict`.
2. Strict mode rejects non-compliant skill structures and frontmatter.
3. Auto-skill pipeline supports draft -> refine -> validate -> promote with deterministic fallback.
4. CLI validator and migration command are available and documented.
5. Test suite covers strict loader behavior, validator behavior, and pipeline behavior.
6. Docs explain operator migration path and runtime expectations.

