# Development

## Develop Locally

Prerequisites:

- Node.js 24+
- pnpm 11+

```bash
pnpm install
pnpm build
node dist/index.js --help
```

Use a local build inside a project:

```bash
node /path/to/visp-hyper-agent/dist/index.js --project /path/to/project init --tool claude-code
node /path/to/visp-hyper-agent/dist/index.js --project /path/to/project run "implement offline note sync"
```
## Development

Keep source and test changes separate from documentation-only cleanup, and run
`pnpm check` before committing either scope. The local `.visp/` directory is
ignored workflow evidence: if it is deleted before a task closes, recreate the
task and collect fresh evidence rather than claiming the earlier task complete.

```bash
pnpm check            # typecheck + test with a coverage report
pnpm test             # the same suite without coverage
pnpm test:pair        # verify this checkout against a sibling visp-kit build
pnpm test:pair:served # verify it against the Kit npm serves — no checkout needed
pnpm exec vitest run tests/<file>.test.ts
```

`pnpm check` does **not** cover the Kit<->Hyper seam. The one test that drives
the real Kit binary skips when a built Kit and an initialized `.visp/` are
absent, and a skipped test reports as a pass. The pair check treats that skip
as a failure and records which artifacts and which surface produced the result
— see [pair verification](pair-verification.md).

`pnpm test:pair:served` is the one to reach for if you do not have visp-kit
checked out, which includes every outside contributor: it installs the
published Kit into the gitignored `.visp/hyper/served-kit/`, initializes
`.visp/` if this checkout has none, and records the tarball and integrity hash
of the artifact it drove.

Every entry point above builds `dist/` first, including the single-file form.
Several suites drive the published artifact — they spawn `node dist/index.js`,
render a git hook's command line, or run `npm pack` against the file list on
disk — so the suite builds once in `tests/setup/build-dist.ts`, registered as
Vitest `globalSetup`, before any test file is collected. A new test that needs
the artifact does not have to arrange anything, and no test may build on its own
(`tests/build-precondition.test.ts` enforces both). It costs about five seconds
per run and it is why a single test file passes from a clean clone on the first
attempt.
