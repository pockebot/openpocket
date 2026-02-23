---
name: issue-plan
on:
  issues:
    types: [opened]

engine: codex
strict: true

permissions:
  contents: read
  issues: read

network:
  allowed:
    - defaults
    - node

tools:
  github:
    toolsets: [repos, issues]
  edit:
  bash: ["make", "git:*"]

safe-outputs:
  add-comment:
  add-labels:
    allowed: [bug, needs-info, enhancement, question]
---

# Issue triage + fix plan

Analyze the new issue.

Issue context (sanitized): "${{ needs.activation.outputs.text }}"

Tasks:
1. Classify the issue and apply up to 2 labels from the allowlist.
2. Identify missing information and ask concise follow-up questions if needed.
3. Produce a concrete fix plan with:
   - root cause hypotheses
   - likely files/modules to edit
   - reproduction steps
   - minimal fix approach
   - tests to add/update
   - risk and rollback notes
4. Only if the issue explicitly points to a failing test/build, run `make ci` once and include the result summary.
