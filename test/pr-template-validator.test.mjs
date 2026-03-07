import assert from "node:assert/strict";
import test from "node:test";
import { validateBody } from "../scripts/validate-pr-template.mjs";

test("validateBody accepts a complete PR body", () => {
  const body = `## Summary
- add a new workflow

## Why
- enforce contribution rules

## Changes
- add a contribution guide
- add a pull request template

## Testing
- node --test test/pr-template-validator.test.mjs

## Checklist
- [x] I ran relevant tests, or the Testing section explains why I did not.
- [x] I updated docs, or confirmed no doc changes were needed.
- [x] I confirmed the PR does not include secrets, credentials, or private data.
`;

  assert.deepEqual(validateBody(body), []);
});

test("validateBody rejects empty sections and unchecked checklist items", () => {
  const body = `## Summary
<!-- fill me -->

## Why
Because.

## Changes
<!-- fill me -->

## Testing
Not run.

## Checklist
- [ ] I ran relevant tests, or the Testing section explains why I did not.
- [x] I updated docs, or confirmed no doc changes were needed.
- [x] I confirmed the PR does not include secrets, credentials, or private data.
`;

  const errors = validateBody(body);
  assert.ok(errors.includes("Section ## Summary must not be empty."));
  assert.ok(errors.includes("Section ## Changes must not be empty."));
  assert.ok(errors.includes("All checklist items must be checked before merging."));
});

test("validateBody rejects missing sections", () => {
  const errors = validateBody("## Summary\n- only one section\n");
  assert.ok(errors.includes("Missing required section: ## Why"));
  assert.ok(errors.includes("Missing required section: ## Changes"));
  assert.ok(errors.includes("Missing required section: ## Testing"));
  assert.ok(errors.includes("Missing required section: ## Checklist"));
});
