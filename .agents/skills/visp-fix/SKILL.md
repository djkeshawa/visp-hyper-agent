---
name: visp-fix
description: Use this when Visp verification, review, or reconciliation failed and the user wants a scoped repair.
---

# Visp Fix Workflow

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

Use this workflow when verification, review, or reconciliation failed.

## Required commands

1. Run `visp status`.
2. Identify the active feature and selected task.
3. Read `.visp/prompts/current-task.prompt.md`.
4. Read `.visp/features/<feature>/verification.md` if present.
5. Read `.visp/features/<feature>/review/<task>.review.md` if present.
6. Read `.visp/features/<feature>/reconcile/<task>.reconcile.md` if present.
7. Fix only the reported issues.
8. Run `visp verify --task <task-id>`.
9. Run `visp review --task <task-id>`.
10. Run `visp reconcile --task <task-id> --update-traceability`.

## Repair rules

- Repair mode cannot add new functionality outside the selected task.
- Do not modify unrelated files.
- Do not broaden the task scope to make findings disappear.
- Do not add dependencies unless the selected task or plan explicitly allows them.

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

## Completion criteria

A task is complete only when:
- selected task implementation is done
- implementation checklist is updated or included in the final response
- actual token usage is recorded, or explicitly marked unavailable when the agent surface does not expose it
- validation commands ran or failure is reported
- `visp verify --task <task-id>` passes
- `visp review --task <task-id>` has no blocking findings
- `visp reconcile --task <task-id> --update-traceability` passes
- `visp next` gives the next valid step

## What not to do

- Do not implement new feature scope.
- Do not skip failed report findings.
- Do not claim completion until Visp reports support it.
