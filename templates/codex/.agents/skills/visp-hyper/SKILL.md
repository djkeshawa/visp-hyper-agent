---
name: visp-hyper
description: >-
  Run a disciplined coding session driven by the visp-hyper companion. Use when
  starting any non-trivial task in a project that has visp-hyper installed.
---

# Skill: visp-hyper session

## When to use

Any time you begin a task in a project that uses visp-hyper. It selects context and
prints an Agent Handoff Protocol that governs the whole session.

## Steps

1. Run `visp-hyper run "<goal>"`.
2. Read the printed handoff and action block. Read the required files, respect the
   allowed/forbidden file scopes, and note the validation commands.
3. Do the work within scope, then run the validation commands and confirm they pass.
4. If a BLOCKED block prints, run the named next command instead of coding.
5. Run `visp-hyper checkpoint --task <id>` to collect local validation evidence.
   Hyper checkpoint results are local evidence only.
   Strict progression and remediation require the exact current ready Kit action.
   In a genuinely Kit-less workflow, local evidence may guide local progression.
6. Record learnings with `visp-hyper remember --summary "<learnings>"`.
   Remember records session learnings and does not complete a Kit task.

## Cost routing

Delegate scanning and mechanical edits to a cheaper context when supported; reserve
the strongest model for real logic and design decisions.
