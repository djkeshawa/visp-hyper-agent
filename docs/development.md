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
pnpm check     # typecheck + test
pnpm test
pnpm exec vitest run tests/<file>.test.ts
```

Every entry point above builds `dist/` first, including the single-file form.
Several suites drive the published artifact — they spawn `node dist/index.js`,
render a git hook's command line, or run `npm pack` against the file list on
disk — so the suite builds once in `tests/setup/build-dist.ts`, registered as
Vitest `globalSetup`, before any test file is collected. A new test that needs
the artifact does not have to arrange anything, and no test may build on its own
(`tests/build-precondition.test.ts` enforces both). It costs about five seconds
per run and it is why a single test file passes from a clean clone on the first
attempt.
