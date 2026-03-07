# Contribution Guide

This repository expects every external change to land through a pull request.
Use this document together with the pull request template in [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md).

## Before You Start

- work from the latest `main`
- keep changes scoped to one goal per pull request
- avoid mixing feature work, refactors, and unrelated cleanup in one PR
- do not commit secrets, private credentials, or personal data

## Branching

- create a topic branch for each change
- use a short, descriptive branch name
- keep the branch rebased or merged with `main` until it is ready to merge

## Development Expectations

- prefer small, reviewable commits
- update code, docs, and tests together when they are logically coupled
- preserve existing behavior unless the PR explicitly changes it
- explain risky migrations, compatibility tradeoffs, or rollout constraints in the PR body

## Pull Request Requirements

Every PR must follow the repository template and include these sections:

- `## Summary`
- `## Why`
- `## Changes`
- `## Testing`
- `## Checklist`

The sections must contain real content. Empty sections, placeholder-only sections, and unchecked checklist items are treated as invalid.

## Testing Guidance

The `## Testing` section must contain one of the following:

- the commands you ran, such as `npm test`
- a short explanation of why tests were not run

If the change affects docs only, say so explicitly.
If the change affects runtime behavior, list the validation you ran.

## Checklist Rules

The PR checklist is mandatory.
Before opening or merging a PR, mark every checklist item as completed.
Do not leave unchecked boxes in the submitted PR body.

## Recommended PR Shape

A strong PR usually has:

- one clear user-facing goal
- a short explanation of why the change exists
- an implementation summary focused on behavior, not narration
- concrete validation steps
- explicit notes for anything that reviewers should watch for

## Merge Standard

A PR is ready to merge when:

- the PR body matches the template
- required CI checks pass
- review comments are resolved or explicitly addressed
- the change is safe to land on `main`
