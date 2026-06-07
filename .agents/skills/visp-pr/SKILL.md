---
name: visp-pr
description: Use this when the user asks to prepare a PR summary through Visp Kit.
---

# Visp Pr Workflow

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

Use this workflow when the user asks to prepare a PR.

## Required commands

1. Run `visp status`.
2. Run `visp policy validate`.
3. Run `visp gate pr`.
4. If the PR gate blocks, stop and explain the exact missing steps.
5. If the PR gate passes, run `visp pr`.
6. Read `.visp/features/<feature>/pr.md`.
7. Summarize PR readiness honestly.

## PR rules

- Do not claim verification passed unless Visp evidence says it passed.
- Do not call GitHub API.
- Do not commit, push, tag, publish, or open a browser.
- Do not hide warnings or follow-up work.

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

- Do not create a normal PR summary when `visp gate pr` blocks.
- Do not invent requirements, tests, or validation evidence.
