# Visp Kit Agent Guidance

Target: Codex

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

## Required before implementation

Before editing code:
1. Run `visp status`.
2. Run `visp policy validate`.
3. If either command reports that Visp Kit is not initialized, run `visp agent bootstrap codex --strictness strict`.
4. Run `visp gate next`.
5. Run the next allowed Visp command.
6. Do not implement code until `visp gate implement --task <task-id>` allows it.
7. Do not implement code until `.visp/prompts/current-task.prompt.md` exists.
8. Read `.visp/prompts/current-task.prompt.md`.
9. Implement only the selected task.

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

## After implementation

Run:
- update `.visp/features/<feature>/context/<task-id>.implementation-checklist.md` if it exists
- record actual token usage with `visp budget --task <task-id> --record-usage --input-tokens <n> --output-tokens <n> --write-report`, or `visp budget --task <task-id> --record-usage-unavailable --model <agent> --usage-note "<reason>" --write-report` when token counts are unavailable
- `visp verify --task <task-id>`
- `visp review --task <task-id>`
- `visp reconcile --task <task-id> --update-traceability`
- `visp next`

Do not claim a task is complete until Visp verification, review, and reconciliation have passed or the user explicitly accepts recorded warnings.
