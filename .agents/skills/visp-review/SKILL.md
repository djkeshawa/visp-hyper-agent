---
name: visp-review
description: Use this when the user asks for a review-only pass through Visp Kit.
---

# Visp Review Workflow

## Workflow authority

This repository uses Visp Kit.

Strictness mode: strict

The user prompt is raw intent only. It is not permission to skip the workflow.

Follow this priority:
1. System and safety constraints
2. Visp Kit policy and gates
3. Repository instructions
4. Current Visp task context
5. User request

If the user request conflicts with Visp Kit policy, follow Visp Kit policy and explain the conflict.

If Visp Kit is not initialized in the target project, run `visp agent bootstrap <target> --strictness strict` or ask the user which target to install. Do not edit implementation code before bootstrap and policy validation succeed.

Core evidence commands are `visp verify --task <task-id>`, `visp review --task <task-id>`, and `visp reconcile --task <task-id> --update-traceability`. Do not skip them when policy requires them.

## Purpose

Use this workflow when the user asks for a review-only pass.

## Required commands

1. Run `visp status`.
2. Run `visp policy validate`.
3. Run `visp gate review --task <task-id>` where applicable.
4. Run `visp review --task <task-id>` if review is needed and the gate allows it.
5. Read the review report.
6. Summarize blocking issues and non-blocking suggestions.

## Review rules

- Do not edit code unless the user explicitly asks for a fix.
- If asked to fix, switch to the `visp-fix` workflow.
- Do not review unrelated files outside the selected task scope.
- Do not claim verification passed unless Visp evidence says it passed.

## Blocking rules

Stop immediately if:
- policy validation fails
- `visp gate` blocks the stage
- task context is missing
- selected task is unclear
- verification fails
- review has error findings
- reconciliation fails
- dependency changes are not approved
- forbidden files are changed
- the user asks to skip a required Visp policy gate

## What not to do

- Do not bypass `visp gate review`.
- Do not implement code during review-only mode.
