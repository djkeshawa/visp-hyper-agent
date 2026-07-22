# ADR 0001: Visp Kit Is Authoritative for Kit-Backed Workflows

- **Status:** Accepted
- **Decision date:** 2026-07-16
- **Scope:** Phase 0 product and repository boundary
- **Related inventory:** `docs/architecture/phase-0-duplicate-semantics-inventory.md`
- **Follow-up decision:** `docs/adr/0002-direct-entry-points-are-kitless-only.md`

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

The direct `start` and `quick` product semantics were intentionally left open by this ADR. ADR 0002 now settles that choice: both commands are Kit-less-only and must stop before side effects whenever Kit is healthy or configured but unhealthy.

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

## P1-06 addendum: negotiated WorkflowAction consumption

Accepted under workspace decision D-046, P1-06 adds a separate Hyper-owned
negotiated action path without changing the historical Phase 0 decision above.
The existing selector-less `nextAction` APIs and all strict command/MCP frames
remain WorkflowAction `2.0` consumers until P1-07.

The new path uses an immutable local preference table (`3.0`, then `2.0`) and
literal local trust anchors for the accepted v2/v3 schema hashes. Advertised
order, advertised default, Kit package SemVer, and runtime Kit files do not
define Hyper preference or trust. A structurally coherent advertisement is
required before an advertised exact protocol is requested, and a selected hash
mismatch is terminal rather than a reason to try a lower version. An exact
integration contract `2.0` with no own `protocols` property remains the bounded
legacy exception: auto or explicit v2 uses selector-less v2, while explicit v3
fails. Legacy provenance is labelled `legacy_unadvertised`; its local pin is
not described as an advertised or remotely verified hash.

Hyper validates the selected wire action with independent strict local schemas,
checks the response protocol and contract/action identity, rejects configured
`local_checked` assurance and process/verdict contradictions, and independently
recomputes WorkflowAction `3.0` identity. V3 identity removes only
`protocolVersion` and `actionId`, retaining `canonicalVersion` and every other
canonical body field before canonical-json-v1 hashing with the accepted domain.

Both wire versions adapt into one deeply immutable Hyper normalization model.
That model is not a claim that lossy v2 is a complete Kit canonical v3 action.
Every v3-only fact missing from v2 is explicitly
`unavailable/not_in_protocol`; Hyper does not fill it from status, task graphs,
sessions, routing, Memory, or prior output. V2 finding strings remain opaque and
are not parsed into structured effects.

The local schema hashes identify the reviewed Kit JSON Schema artifacts. Hash
equality alone does not formally prove that Hyper's independently authored Zod
validators are equivalent to those schemas. Support claims therefore remain
bounded to the reviewed positive/negative corpus and exact packed Kit/Hyper
pairs whose installed schemas, advertisement, selection, action parsing, and
rendering evidence passed. P1-08 owns a broader compatibility matrix.

P1-06 temporarily retains two v2 validators: the existing tolerant validator
protects unchanged pre-P1-07 consumers, while the new negotiated path uses the
strict public-contract mirror. P1-07 must consolidate that duplication when it
migrates `run`, `next`, `resume`, checkpoint, `guard`, and MCP rendering. Doctor
may exercise and report the negotiated path as diagnostics; it does not turn
that result into an independent permission decision.

## P1-07C1 addendum: canonical-action MCP resource

Accepted under workspace decision D-051, P1-07C1 exposes the current normalized
Kit action as the computed `visp-hyper://current/canonical-action` MCP resource.
Each read performs fresh Kit detection, validates one integration contract, and
uses that exact contract to acquire the canonical action. A coherent Kit action
is wrapped only with the frozen public Hyper envelope; genuine Kit absence and
configured or contract-level failures use distinct unavailable or inconclusive
resource states without a local fallback, cache, timestamp, or state mutation.

The resource is a presentation adapter, not another authority or operation
result. Its full public action is required to agree with `run`, `next`,
`resume`, `guard`, and checkpoint when all six surfaces consume the same
immutable Kit response. Guard and checkpoint results remain separate from the
action verdict. Removal of the obsolete tolerant v2 bridge/schema and legacy
Hyper presentation reader remains blocked for the separately authorized
P1-07C2 unit.
