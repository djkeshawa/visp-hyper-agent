# MCP server

## MCP Server

`visp-hyper serve --mcp` exposes the same orchestration surface over stdio JSON-RPC for MCP-capable tools.

Each tool advertises JSON Schema for both inputs and outputs. Calls still return
the human-readable Visp blocks, and also include `structuredContent` with status,
frame, resource URI, and raw text fields so MCP hosts and weaker coding models do
not need to scrape prose to understand whether a gate passed.

Tools:

- `hyper_quick`
- `hyper_run`
- `hyper_next`
- `hyper_resume`
- `hyper_status`
- `hyper_doctor`
- `hyper_checkpoint`
- `hyper_guard`
- `hyper_review`
- `hyper_remember`
- `hyper_report`

Resources:

- `visp-hyper://meta/surface-manifest`
- `visp-hyper://current/canonical-action`
- `visp-hyper://current/context-freshness`
- `visp-hyper://current/kit-read-contract`
- `visp-hyper://current/session`
- `visp-hyper://current/context-pack`
- `visp-hyper://current/context-manifest`
- `visp-hyper://current/memory-pack`
- `visp-hyper://current/quality-gates`
- `visp-hyper://current/agent-instructions`
- `visp-hyper://current/handoff-json`
- `visp-hyper://current/checkpoints`
- `visp-hyper://current/checkpoint-snapshot`
- `visp-hyper://current/review-report`
- `visp-hyper://prompts/handoff`

`visp-hyper://meta/surface-manifest` is always available. It declares the fixed MCP tool/resource/prompt surface, per-tool input schema hashes, the server version, and a stable SHA-256 `surfaceHash` so MCP hosts and enterprise reviewers can detect unexpected surface drift.
It also hashes each tool output schema, making text-only regressions and schema drift visible to integration checks.
`visp-hyper://current/canonical-action` computes the current validated Kit action on every read. Healthy Kit-backed projects return the negotiated canonical action, including Kit-authored WorkflowAction 3.2 assurance status and review-decision state when available; genuine Kit absence and configured failures return distinct unavailable or inconclusive states without a local authority fallback.
`visp-hyper://current/context-freshness` is also always available. It reports the active context pack and grounded Kit artifact freshness as JSON, including `status`, `blocking`, hashes, warnings, and any finding that should stop a coding agent before it drifts.
`visp-hyper://current/kit-read-contract` is always available too. When a Kit `1.3` handoff is active, it returns the adopted artifact roles, MIME types, required stages, and freshness policy; otherwise it returns an explicit `unavailable` status.

Prompts:

- `hyper_resume`
- `hyper_run_goal`
