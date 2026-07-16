# ADR 0001: Visp Kit Is Authoritative for Kit-Backed Workflows

- **Status:** Accepted
- **Decision date:** 2026-07-16
- **Scope:** Phase 0 product and repository boundary
- **Related inventory:** `docs/architecture/phase-0-duplicate-semantics-inventory.md`

## Context

Visp Hyper Agent is the deterministic orchestration and host-integration layer around coding hosts. It manages sessions, branch and worktree association, host assets, supported subagents, cited Memory context, and transparent advisory model routing. Visp Kit is the specification, policy, task, scope, evidence, verification, review, reconciliation, assurance, and PR-readiness engine.

Hyper currently contains paths that render Kit results correctly, but it also contains paths that reconstruct task, scope, progression, evidence, or completion from local state. Some of those paths are useful in a genuine Kit-less workflow. They are unsafe when a project is configured to use Kit but Kit authority is unavailable or cannot be evaluated, because a local fallback can disagree with the authoritative result.

This decision establishes one boundary for every Kit-backed command and integration.

## Current contract baseline

The accepted Phase 0 baseline is:

- WorkflowAction `2.0`;
- integration contract `2.0`; and
- orchestrator read contract `0.1`.

WorkflowAction `2.0` provides `protocolVersion`, `phase`, `taskId`, `goal`, hash-pinned `requiredReads`, `writablePaths`, `forbiddenPaths`, `acceptanceOracles`, `validationCommands`, `assuranceLevel`, `verdict`, `findings`, and one exact `nextCommand`.

It does not provide `taskClass`, protocol negotiation, schema hashes, complete required-evidence definitions, the authoritative dependency and task-status graph, ready sibling tasks, or authoritative post-checkpoint completion and PR state.

Compatibility claims cover only exact Kit and Hyper pairs for which the named evidence actually ran. At this decision point, the recorded live-binary baseline is an unpacked three-case drift check; packed-pair compatibility remains a Phase 0 completion gate. No semantic-version support window is proven or implied. Protocol negotiation, schema identity, canonical v2/v3 derivation, WorkflowAction `3.0`, and a wider compatibility window remain future, separately authorized work. They are not current runtime capabilities.

## Decision

### Kit owns Kit-backed authority

For every Kit-backed workflow, Kit alone decides:

- whether an implementation or workflow step is permitted;
- the active feature and task;
- allowed, expected, and forbidden file scope;
- policy status, findings, and valid overrides;
- acceptance claims, required evidence, and evidence sufficiency;
- verification, review, and reconciliation results;
- assurance level and completion state; and
- whether work is ready for a pull request.

Hyper must consume, validate against an explicitly supported schema, and faithfully render Kit contracts. Hyper may add presentation and operational context, but it must not infer omitted authority, replace an exact Kit command, weaken a verdict, or independently declare a `kit_strict` pass.

### Hyper owns orchestration and integration

Hyper owns:

- session creation, continuation, and host-facing session state;
- branch and worktree-to-session mapping;
- coding-host integration, capability manifests, installed assets, and output rendering;
- coordination of explicitly supported subagents;
- adapters that retrieve cited Visp Memory context for a session;
- transparent, evidence-based advisory model routing; and
- genuine Kit-less local workflows when the user explicitly selects them.

Neither Kit nor Hyper calls an LLM. The coding host owns model execution. Hyper's routing output is advice, not policy, assurance, or permission.

### Three operating modes

1. **Genuine Kit-less** means no Kit configuration or Kit signals are present and the workflow is explicitly local. Hyper may run deterministic local checks, but the result must be labelled `advisory` or `local_checked`, never `kit_strict`. Unavailable Kit checks must remain visible.
2. **Kit-backed healthy** means the configured Kit binary and required artifacts are available, fresh, supported, and valid. Hyper consumes validated Kit output verbatim and does not reconstruct permission, scope, advancement, completion, or PR readiness.
3. **Configured unhealthy** means Kit is configured or its artifacts signal a Kit-backed project, but required authority is missing, malformed, unsupported, timed out, stale, uninitialized, returned a non-zero or unparseable result, or is otherwise unevaluable. Hyper must block or report an inconclusive state. It must not silently enter the genuine Kit-less path or produce `kit_strict` success.

Configured-but-unhealthy Kit is not genuine Kit absence. A broad availability boolean is insufficient to choose between those modes.

The direct `start` and `quick` product semantics are intentionally not settled by this ADR. A later product decision must choose between requiring an always-explicit local mode and blocking those commands when a project is configured for strict Kit operation.

### Memory is context, not authority

Visp Memory may supply cited, provenance-bearing project knowledge. Memory is non-authoritative and cannot grant workflow permission, alter scope, validate an override, certify evidence, advance or complete a task, or declare PR readiness. Memory unavailability may degrade context quality; it must not change a Kit verdict.

### Human accountability remains required

Visp does not automatically merge changes, and AI output alone cannot approve work. A human remains accountable for accepting changes and initiating merge or release actions.

## Fail-closed rule

When a Kit-backed command needs authority, any missing, malformed, unsupported, timed-out, stale, unavailable, or otherwise unevaluable required Kit result fails closed. The user-facing result must preserve the reason and the exact Kit next action when one exists. Hyper must not invent a permissive default, a replacement scope, a completion claim, or a new strict next command.

This rule applies equally to CLI commands, MCP responses, session resume, checkpoint progression, scope guards, and coding-host rendering.

## Migration rule

Duplicated strict behavior may be removed from Hyper only after all of the following are true:

1. Kit exposes equivalent authoritative coverage in a versioned contract.
2. Kit tests prove the new field or state, including malformed and fail-closed cases.
3. Hyper adapter tests prove faithful parsing and rendering without reconstruction.
4. Exact packed Kit and Hyper compatibility tests pass for every claimed pair.
5. The supported-protocol data, ADRs, schemas, and compatibility evidence are updated together.
6. Useful Kit-less behavior is either preserved behind an explicit local boundary or deliberately retired by a separate product decision.

Runtime behavior is not removed merely because an intended future contract is documented. WorkflowAction `3.0`, schema hashes, negotiation, canonical v2/v3 derivation, and a wider support window remain gated future design.

## Consequences

### Positive

- One engine owns workflow permission and assurance.
- Coding hosts receive one canonical action instead of competing reconstructions.
- Local workflows remain useful without being mistaken for strict assurance.
- Memory, routing, and subagent features can evolve without becoming policy engines.
- Compatibility claims become measurable and reproducible.

### Costs and follow-up

- Configured Kit failures become visible blockers instead of silent degradation.
- Hyper needs a richer backend-state model than `available: boolean`.
- Several strict paths cannot be removed until Kit exposes missing graph, evidence, and post-checkpoint state.
- Existing documentation and tests that encode permissive fallback require later, bounded, tests-first corrections.
- Every contract change requires packed-binary compatibility evidence before support is claimed.

The Phase 0 inventory linked above records the current symbols, risks, contract gaps, and smallest follow-up units. This ADR authorizes documentation of the boundary only; it does not authorize a runtime correction or WorkflowAction `3.0` implementation.
