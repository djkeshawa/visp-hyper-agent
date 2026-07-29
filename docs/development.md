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
pnpm check     # typecheck + test + build
pnpm test
pnpm exec vitest run tests/<file>.test.ts
```
