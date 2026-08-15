# Pair verification

Hyper is half of a pair. Kit decides and Hyper coordinates, and the thing that
can break between releases is the seam: the flags Hyper passes, the JSON shapes
it parses, the protocol version it negotiates. Everything else in this
repository can be tested against a fixture. That seam cannot.

This page says exactly how the seam is verified, what that verification is worth
on each surface, and what is still not covered.

## The one test that touches the real Kit

`tests/visp-binary-contract.test.ts` drives the actual Kit binary — not
`tests/helpers/visp-shim.ts`, which answers with fixed JSON and does not
validate CLI flags. Three real bugs in this repository's history were caught
only by live-testing, because bridge invocation drift is invisible to a shim
that never reads the flags.

It needs two things the rest of the suite does not: a built Kit beside the
checkout, and an initialized `.visp/` inside it. Neither exists in a fresh
clone, so the test is guarded by `describe.skipIf`.

**A skipped test reports as a green tick.** Measured on this repository with
Vitest 3.2.6, a fully skipped `describe` produces this JSON summary:

```json
{ "numTotalTests": 2, "numPassedTests": 0, "numPendingTests": 2,
  "numFailedTests": 0, "success": true }
```

`success: true`, nothing verified. So `pnpm test` passing does **not** mean the
pair was verified. It usually means the opposite: that the pair was absent and
the contract test stepped aside.

## The pair check

```bash
pnpm test:pair
```

`scripts/pair-check.mjs` is the thing that turns that silence into a signal. It
exits 0 only when all three of the following held in one run:

1. A Kit build was found and answered `--version` — a working binary, not a
   stale or truncated `dist/index.js`.
2. Kit artifacts existed in the Hyper checkout, so the contract test had
   something real to read.
3. Every contract test **executed** and passed: zero skipped, zero pending, at
   least one collected. Vitest's own `success` flag is not consulted, for the
   reason above.

Anything else exits non-zero and names which of the three failed, with the
repair for each. Options: `--kit <path>` (or `$VISP_KIT_PATH`; defaults to the
sibling `../visp-kit`, where the contract test looks), `--hyper <path>`,
`--record <path>`, and `--preconditions-only` to ask whether this machine
*could* verify the pair without running anything.

Every run writes a record:

```json
{
  "checkedAt": "2026-08-15T05:01:05.488Z",
  "surface": "developer-machine",
  "node": "v24.15.0",
  "platform": "linux x64",
  "hyper": { "version": "0.9.0", "commit": "1629df5…", "branch": "develop", "dirty": true },
  "kit":   { "version": "0.6.0", "commit": "aabb7e6…", "branch": "develop", "dirty": false },
  "verdict": "verified",
  "contract": { "counts": { "total": 3, "passed": 3, "failed": 0, "skipped": 0 } }
}
```

That is the actual record of the most recent verified run at the time of
writing: Hyper `0.9.0` at `1629df5` against Kit `0.6.0` at `aabb7e6`, on one
Linux x64 machine, Node 24.15.0, with Hyper's working tree dirty. The record
exists so the claim is attributable instead of remembered. `dirty: true` means
the run does not cleanly belong to the commit it names, and the record says so
rather than rounding it off. Identity fields are `null` when git could not be
consulted — "we do not know" and "the tree is clean" are different facts and are
never collapsed into each other.

The default record path is `.visp/hyper/pair-check.json`, which is gitignored:
it describes a run, not the source.

## Why there is no CI run covering the pair

`.github/workflows/ci.yml` has two jobs. `check` runs typecheck, build and the
full suite on Ubuntu and Windows across Node 22 and 24. It does **not** cover
the pair, and cannot: it has no Kit, so the contract test skips there by design.

The `contract` job is the one that would cover the pair. It checks out
`djkeshawa/visp-kit` beside this repository, builds both, initializes a project,
and runs the pair check. Every one of its steps is conditional on a repository
secret, `VISP_KIT_TOKEN`, and it is conditional for a reason that does not go
away:

- **visp-kit is a private repository.** The default `GITHUB_TOKEN` is scoped to
  this repository only, so the cross-repository checkout needs a personal access
  token with `repo` scope. Forks and outside contributors do not have it and
  cannot be given it. For anyone but the owner, this job cannot run at all.
- **This repository is published by hand.** The working branch is not
  continuously pushed, so the workflow on the remote is not necessarily the
  workflow in this tree, and no run of the current file has been observed from
  here.

Two consequences worth stating plainly:

- **A green `contract` tick does not mean the pair was verified.** When the
  token is absent the job emits a `::warning` annotation and every step is
  skipped — deliberately, so forks are not blocked — and the job still reports
  success. The only proof the pair was verified in CI is the uploaded
  `pair-check-record` artifact with `"verdict": "verified"` and
  `"surface": "ci"`. Absence of that artifact means the pair was not covered,
  whatever colour the tick is.
- **No pair-check record produced on a CI surface exists as of this writing.**
  Every verification of this pair on record was produced on a developer machine.
  That is a weaker claim than a CI run and is not presented as an equal one.

## What is still not covered

- **One platform, one machine.** The verified pair record above is Linux x64,
  Node 24.15.0. The pair has not been verified on Windows or macOS, on Node 22,
  or on any second machine. The cross-platform matrix in `check` covers the
  suite, not the pair.
- **One commit pair at a time.** The check verifies the two checkouts that
  happen to be on disk. It is not a compatibility range, and a passing record
  says nothing about any other pair of commits. Hyper's declared
  `peerDependencies.visp-kit` range is recorded in the run record but is not
  enforced by it.
- **Read-only surface only.** The contract test deliberately calls only
  `status`, `policy validate` and the canonical-action API. It never calls
  `gate`, `verify` or `reconcile`, which would mutate the working tree, so the
  write side of the seam is not covered by this check.
- **Running it is a human decision.** Until a CI surface produces records, the
  pair check is only as reliable as somebody remembering to run it before a
  release.
