# ADR 0002: Direct Entry Points Are Kit-Less-Only

- **Status:** Accepted
- **Decision date:** 2026-07-18
- **Scope:** Direct `visp-hyper start` and `visp-hyper quick` entry points
- **Extends:** `docs/adr/0001-kit-is-authoritative.md`

## Context

ADR 0001 established that Kit alone owns permission, scope, progression, evidence sufficiency, completion, and pull-request readiness in a Kit-backed workflow. It left one product choice open: whether direct `start` and `quick` should offer an explicit local override in a configured Kit project or stop when Kit is present.

Allowing a local override would create a second path around Kit authority. It would also make a broken, unavailable, malformed, or non-ready Kit look similar to a genuinely Kit-less project. That ambiguity is unsafe because the local path creates session, handoff, and pipeline files.

## Decision

Direct `visp-hyper start` and `visp-hyper quick` are available only in a genuinely Kit-less project.

Both commands must detect Kit before creating Hyper session, pipeline, handoff, or other workflow state:

1. If Kit is healthy, stop with conservative guidance to use the Kit-backed `run` flow.
2. If Kit is configured but unhealthy or cannot be evaluated, stop with the reason and do not fall back locally.
3. Only genuine Kit absence may enter local mode. Local output must be labelled local or advisory, never `kit_strict`.

No configured-Kit local override is provided. Kit-backed work enters through `visp-hyper run`, which must consume Kit's validated contracts and exact current action.

## Host wording

A Hyper checkpoint, review, or local `PASSED` result is evidence only. It may guide a genuinely Kit-less local workflow, but it does not authorize strict progression or remediation. In Kit-backed work, hosts must follow the exact current ready Kit action and next command.

`visp-hyper remember` records Hyper session learnings. It does not complete a Kit task or change Kit's authoritative status.

## Consequences

- Direct commands fail early instead of silently bypassing configured Kit authority.
- A broken Kit remains visible as a blocker rather than being treated as absence.
- Users choose `run` for Kit-backed work and direct `start` or `quick` for genuinely Kit-less local work.
- Host integrations must describe Hyper validation as local evidence and reserve strict progression, remediation, and completion claims for Kit.
