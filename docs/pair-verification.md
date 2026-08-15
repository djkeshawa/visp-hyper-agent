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

It needs two things the rest of the suite does not: a Kit build it can run, and
an initialized `.visp/` inside the checkout. Neither exists in a fresh clone, so
the test is guarded by `describe.skipIf`.

Which Kit it drives is decided in `tests/helpers/kit-entry.ts`: `$VISP_KIT_PATH`
first, then the sibling `../visp-kit`, then `visp` on PATH. A `$VISP_KIT_PATH`
that does not resolve is an error, never a fallback — the pair check sets that
variable to the Kit it probed and is about to name in the record, and a run
that quietly exercised some other Kit would make the record a lie.

**A skipped test reports as a green tick.** Measured on this repository with
Vitest 3.2.6, a fully skipped `describe` produces this JSON summary:

```json
{ "numTotalTests": 2, "numPassedTests": 0, "numPendingTests": 2,
  "numFailedTests": 0, "success": true }
```

`success: true`, nothing verified. So `pnpm test` passing does **not** mean the
pair was verified. It usually means the opposite: that the pair was absent and
the contract test stepped aside.

## Two pairs, and which one you can run

There are two Kit↔Hyper pairs worth checking, and they are not the same claim.

| | What it exercises | Who can run it |
|---|---|---|
| **The served pair** — `pnpm test:pair:served` | The Kit npm serves, driven by this working tree | Anyone with a clone and a network |
| **The source pair** — `pnpm test:pair` | A `visp-kit` checkout beside this one, usually both on `develop` | Whoever can clone the private `visp-kit` |

The served pair is the one that matters to a user: `visp-kit`'s source
repository is private, but its **package is public**, so the published tarball
is both reproducible by an outside contributor and the exact thing a user
installs. The source pair catches breakage earlier — before either side
publishes — and is the owner's tool.

Neither is a compatibility range. Each verifies exactly the two artifacts that
were on disk, which is the whole model: compatibility here is pinned by commit
and artifact hash, never by a version range (visp-kit ADR 0007). Hyper
therefore declares no `peerDependencies` on `visp-kit` — a range would state a
support claim nobody measured, and the one it used to publish,
`>=0.2.3 <0.7.0`, had a floor the compatibility matrix marks hazardous.

## The pair check

```bash
pnpm test:pair:served   # against the published Kit — no visp-kit checkout
pnpm test:pair          # against a sibling ../visp-kit build
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
repair for each. Options:

- `--kit <path>` (or `$VISP_KIT_PATH`), defaulting to the sibling `../visp-kit`;
- `--kit-npm <spec>` to install a published Kit — `visp-kit@latest` is what
  `pnpm test:pair:served` uses — into the gitignored
  `.visp/hyper/served-kit/` and check against that artifact;
- `--init-if-missing` to initialize `.visp/` with the Kit under test when the
  checkout has none. It never touches an existing `.visp/`;
- `--hyper <path>`, `--record <path>`, and `--preconditions-only` to ask
  whether this machine *could* verify the pair without running anything.

Whichever Kit is selected is passed to the contract test through
`$VISP_KIT_PATH`, so the Kit named in the record is the Kit that ran.

Every run writes a record. This is a real one — the served pair, verified from
this working tree:

```json
{
  "checkedAt": "2026-08-15T11:31:20.881Z",
  "surface": "developer-machine",
  "node": "v24.15.0",
  "platform": "linux x64",
  "hyper": { "version": "0.9.0", "commit": "ea18ece…", "branch": "develop", "dirty": true },
  "kit": {
    "version": "0.5.0",
    "commit": null, "branch": null, "dirty": null,
    "origin": {
      "source": "npm",
      "spec": "visp-kit@latest",
      "resolvedVersion": "0.5.0",
      "tarball": "https://registry.npmjs.org/visp-kit/-/visp-kit-0.5.0.tgz",
      "integrity": "sha512-4ffAkBFWifKEd1Zh1n/5jSJ0joRa2RH1GXiKG1pM+BQ4SJtaCuGWvfZmhXdu6WAg0kuKIINsPAnx7UF6F2enpw=="
    }
  },
  "verdict": "verified",
  "contract": { "counts": { "total": 3, "passed": 3, "failed": 0, "skipped": 0 } }
}
```

Read it as: Hyper `0.9.0` at `ea18ece`, working tree dirty, against the exact
tarball npm served for `visp-kit@latest`, on one Linux x64 machine, Node
24.15.0. `origin` is what makes the record evidence rather than a memory: a
version string does not identify a build, and the integrity hash does.

Every identity field is nullable on purpose. `dirty: true` means the run does
not cleanly belong to the commit it names. `commit: null` means git could not
be asked — an npm-installed Kit has no commit, and "we do not know" is never
collapsed into "the tree is clean". A directory that merely *sits inside* a git
repository gets `null` too, and that is not theoretical: the first served-pair
record read `Kit 0.5.0 @ ea18ece (DIRTY)`, because the Kit had been installed
under Hyper's own `.visp/` and `git -C` walked up to Hyper's repository. Right
version, wrong commit, no warning.

The default record path is `.visp/hyper/pair-check.json`, which is gitignored:
it describes a run, not the source.

## What CI covers, and what a green tick is worth

`.github/workflows/ci.yml` has two jobs.

`check` runs typecheck, build and the full suite on Ubuntu and Windows across
Node 22 and 24. It does **not** cover the pair, and cannot: it has no Kit, so
the contract test skips there by design.

`pair` covers the served pair. It installs `visp-kit@latest` from the public
registry, initializes `.visp/`, and runs the pair check on Ubuntu under Node 22
and 24. **It needs no repository secret**, so it runs on pull requests from
forks exactly as it runs for the owner, and anyone can reproduce it from a
clone with `pnpm test:pair:served`. Because the pair check treats a skipped
contract test as a failure, this job cannot report success having verified
nothing.

### What changed, and why

`pair` replaces a job called `contract`, which checked out the private
`djkeshawa/visp-kit` behind a `VISP_KIT_TOKEN` secret with every step wrapped
in `if: steps.kit_token.outputs.available == 'true'`. For anyone without the
token — every fork, every outside contributor — all of those steps skipped and
**the job still reported success**. That is a green tick standing for a check
nobody outside could execute, which is worse than no check: it answers the
question "is the pair covered?" with a colour rather than a fact.

The source-pair job still exists, in `.github/workflows/pair-source.yml`. Two
things about it are now different: it is `workflow_dispatch` only, so it
contributes no tick to anyone's pull request, and a missing `VISP_KIT_TOKEN` is
a hard failure rather than a skip. A run of it either produces evidence or goes
red.

### What is still true

- **This repository is published by hand.** The working branch is not
  continuously pushed, so the workflow on the remote is not necessarily the
  workflow in this tree, and **no run of the current file has been observed**.
  A workflow in a tree is a plan, not a result.
- **No pair-check record produced on a CI surface exists as of this writing.**
  Every verification on record was produced on a developer machine. The served
  pair — Hyper `0.9.0` at `ea18ece` against the `visp-kit@0.5.0` tarball above —
  was verified there, 3/3 contract tests executed, on Linux x64 and Node
  24.15.0.
- **The record, not the tick, is the proof.** A `pair` run that verified the
  pair uploads `pair-check-record-node<version>` with `"verdict": "verified"`
  and `"surface": "ci"`. Absence of that artifact means the pair was not
  covered, whatever colour the tick is.

## What is still not covered

- **One platform, one machine.** Every record on file is Linux x64, Node
  24.15.0, one developer machine. The `pair` job adds Node 22 on Ubuntu once it
  runs; Windows and macOS remain unverified for the pair, and the
  cross-platform matrix in `check` covers the suite, not the pair.
- **One pair of artifacts at a time.** The check verifies exactly what was on
  disk. It is not a compatibility range and cannot be read as one: a passing
  record says nothing about any other pair. This is the point of the model, not
  a gap in it — but it does mean a record ages the moment either side ships.
- **Read-only surface only.** The contract test deliberately calls only
  `status`, `policy validate` and the canonical-action API. It never calls
  `gate`, `verify` or `reconcile`, which would mutate the working tree, so the
  write side of the seam is not covered by this check.
- **`visp-kit@latest` is a moving target.** The served-pair check follows
  whatever npm serves, which is honest — that is the pair users get — but it
  means the thing being checked can change without this repository changing.
  The record names the resolved version and integrity hash so a past run
  remains readable.
