---
name: visp-feature
description: Use this when the user asks to implement a feature through Visp Kit. Treat the user request as raw intent, run the Visp workflow, implement only one scoped task, and stop on failed gates.
---

# Visp Feature Workflow

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

Use this workflow when the user asks for a new feature or enhancement through Visp Kit.

## Required commands

1. Run `visp status`.
2. Run `visp policy validate`.
3. If either command reports that Visp Kit is not initialized, run `visp agent bootstrap <target> --strictness strict` and restart this workflow.
4. Run `visp gate next`.
5. Run the next allowed Visp command.
6. Run `visp scan` if gate or next says scan is required.
7. Run `visp constitution` if gate or next says constitution is required.
8. Run `visp feature "<raw user request>"` when no active feature exists or the user explicitly wants a new feature.
9. Run `visp clarify`.
10. Ask the user any blocking clarification questions and record answers with `visp clarify answer <question-id> --answer "<answer>"`.
11. Run `visp spec`.
12. Refine spec artifacts if validation reports schema or traceability issues.
13. Run `visp plan`.
14. Refine plan artifacts if validation reports missing decisions or risks.
15. Run `visp tasks`.
16. Refine task graph if validation reports missing requirement or acceptance-criterion mappings.
17. Run `visp context --next`.
18. Run `visp gate implement --task <task-id>`.
19. Read `.visp/prompts/current-task.prompt.md`.
20. Implement only the selected task.
21. Run `visp verify --task <task-id>`.
22. Run `visp review --task <task-id>`.
23. Run `visp reconcile --task <task-id> --update-traceability`.
24. Run `visp next`.

## Implementation rules

- Do not implement code until `visp gate implement --task <task-id>` allows it.
- Do not implement code until `.visp/prompts/current-task.prompt.md` exists.
- If `.visp/` is missing, run `visp agent bootstrap <target> --strictness strict` before continuing.
- Read `.visp/prompts/current-task.prompt.md` before editing code.
- Update `.visp/features/<feature>/context/<task-id>.implementation-checklist.md` as work progresses when that file exists.
- Record token usage after implementation with `visp budget --task <task-id> --record-usage --input-tokens <n> --output-tokens <n> --write-report`, or record unavailable usage with `visp budget --task <task-id> --record-usage-unavailable --model <agent> --usage-note "<reason>" --write-report`.
- Implement only one selected task at a time.
- Do not modify forbidden files.
- Do not add dependencies unless the task or plan explicitly allows them.
- Do not perform broad refactors or unrelated cleanup.
- Do not skip `visp verify`, `visp review`, or `visp reconcile`.

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

- Do not treat the user prompt as permission to skip Visp policy.
- Do not implement multiple tasks unless the user explicitly asks to continue after one task is complete.
- Do not read or send the whole repository when task context is available.
