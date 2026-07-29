# Working inside an agent

## Example Claude Code Workflow

Set up once:

```bash
visp-hyper init --tool claude-code
```

This installs the legacy commands plus current native skills:

```text
.claude/agents/coordinator.md     # routes work, validates results (model: inherit)
.claude/agents/scout.md           # scanning + mechanical work (model: sonnet)
.claude/agents/implementer.md     # real logic (model: opus)
.claude/skills/visp-hyper/SKILL.md
.claude/commands/hyper-run.md     # /hyper-run, /hyper-next, /hyper-checkpoint,
.claude/commands/hyper-*.md       # /hyper-review, /hyper-remember
```

The per-role model tiers above are static assignments written at install time
from `templates/claude-code/model-map.json`. Codex and OpenCode also expose
native skill/subagent surfaces; Copilot capabilities are surface-limited, so its
manifest keeps sequential fallback guidance. Generic mode assumes no native
dispatch.

Then, inside a Claude Code session:

```text
/hyper-run implement offline note sync
# → handoff + task action block (allowed/forbidden files, acceptance
#   criteria, validation commands) + model_routing advice.
#   Acting as the coordinator, delegate the scout pass to the `scout`
#   subagent and implementation to `implementer` via the Agent tool,
#   validating each result before checkpointing.

/hyper-checkpoint T001
# → collects verify + review evidence; follow Kit's exact ready action for strict progress

/hyper-remember done: implemented note sync --input-tokens 18000 --output-tokens 4200
# → session memory, token telemetry, budget round-trip, skill harvest
```

The same flow works tool-agnostically: `--tool codex` writes
`AGENTS.visp-hyper.md` plus `.agents/skills/`; `--tool copilot` writes an
`applyTo`-scoped `.github/instructions/` file; and `--tool opencode` writes a
native `.agents/skills/` entry.
## Skill Harvesting

When your coding agent notices a reusable procedure, it writes a proposal file (the handoff documents the format):

```text
.visp/hyper/skill-proposals/incoming/restart-stack.md
---
name: restart-stack
description: Restart the dev stack cleanly after schema changes.
when_to_use: After any database migration.
evidence: Needed twice this session.
---
1. Stop the dev server. 2. pnpm db:reset && pnpm db:migrate. 3. ...
```

`remember`/`checkpoint` validate, dedupe, and (in the default `skillMode: "auto"`) install it as a namespaced project skill — e.g. `.claude/skills/hyper-restart-stack/SKILL.md` — registered in `.visp/hyper/skills.json`. Set `skillMode: "review"` to stage proposals for human approval instead. Future handoffs advertise installed skills; `report` flags skills unused for 5+ sessions as prune candidates. Existing files are never overwritten.
## Adaptive Model Routing (quality-first)

Routing advice is computed deterministically from local telemetry — visp-hyper never selects or calls a model:

- **Baseline**: every task starts on the strong tier (`implementer`). A missing task class remains unclassified and never borrows evidence from its risk level.
- **Downgrades must be earned**: an explicit task class is suggested for the cheap tier (`scout`) only after at least 30 decided, comparable first-attempt records whose 95% Wilson lower bound is at least 85%.
- **Cohorts do not leak**: downgrade evidence matches task class, risk level,
  assurance profile, host, model ID/version, and project preset. Inconclusive
  attempts are reported separately and excluded from pass-rate math.
- **Risk remains separate**: task class, risk level, and versioned risk factors are recorded independently. High-risk and critical-assurance tasks stay on the strong tier even when their class has downgrade evidence.
- **Quality recovers instantly**: any checkpoint failure escalates the suggestion to the strong tier and quarantines the task class from downgrades for 3 sessions.

Legacy telemetry that used `low`, `medium`, or `high` as a task class is migrated
to an unclassified task with the original risk level. It is preserved for
reporting but excluded from task-class downgrade evidence.

`visp-hyper report` shows class, risk-level, and risk-factor pass-rate evidence behind decisions, so cost cuts that hurt accuracy are visible and reversible.
