import { statSync } from "node:fs";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { readTextIfExists } from "../../core/fs-utils.js";
import { resolveProjectPath } from "./shared.js";

/** Marker identifying a visp-hyper-owned pre-commit hook. */
const GIT_HOOK_MARKER = "# visp-hyper-guard hook";
/** Marker identifying the visp-hyper-owned GitHub Actions workflow. */
const CI_WORKFLOW_MARKER = "# visp-hyper-guard workflow";

const CI_WORKFLOW = `${CI_WORKFLOW_MARKER}
name: visp-hyper gate
on:
  pull_request:
jobs:
  guard:
    runs-on: ubuntu-latest
    env:
      VISP_FEATURE: \${{ vars.VISP_FEATURE }}
      VISP_TASK: \${{ vars.VISP_TASK }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Require explicit Visp scope
        shell: bash
        run: |
          if [ -z "$VISP_FEATURE" ] || [ -z "$VISP_TASK" ]; then
            echo "error: configure repository Actions variables VISP_FEATURE and VISP_TASK."
            exit 1
          fi
      - run: npx --yes --package visp-kit --package visp-hyper-agent visp-hyper guard --base "origin/\${{ github.base_ref }}" --feature "$VISP_FEATURE" --task "$VISP_TASK"
`;

export function hooksCommand(): Command {
  const hooks = new Command("hooks").description(
    "Install enforcement surfaces (git pre-commit hook, CI PR gate)."
  );
  hooks.addCommand(gitSubcommand());
  hooks.addCommand(ciSubcommand());
  return hooks;
}

function gitSubcommand(): Command {
  return new Command("git")
    .description("Install a pre-commit hook that runs `visp-hyper guard --staged`.")
    .action(async function (this: Command) {
      const projectPath = resolveProjectPath(this);

      if (!(await isDir(join(projectPath, ".git")))) {
        console.error("error: not a git repository (run inside a project with .git).");
        process.exitCode = 1;
        return;
      }

      const hookPath = join(projectPath, ".git", "hooks", "pre-commit");
      const existing = await readTextIfExists(hookPath);

      if (existing !== undefined && !existing.includes(GIT_HOOK_MARKER)) {
        console.log(
          "warning: existing pre-commit hook found; not overwriting. Chain `visp-hyper guard --staged` manually."
        );
        return;
      }

      const updating = existing !== undefined;
      await mkdir(dirname(hookPath), { recursive: true });
      await writeFile(hookPath, gitHookContent(), "utf8");
      await chmod(hookPath, 0o755);
      console.log(
        `hooks git: ${updating ? "updated" : "installed"} .git/hooks/pre-commit`
      );
    });
}

function ciSubcommand(): Command {
  return new Command("ci")
    .description("Write a GitHub Actions workflow that runs the guard on pull requests.")
    .addOption(new Option("--force", "Rewrite an existing visp-hyper-owned workflow."))
    .action(async function (this: Command, options: { force?: boolean }) {
      const projectPath = resolveProjectPath(this);
      const destination = join(projectPath, ".github", "workflows", "visp-hyper-gate.yml");
      const relative = ".github/workflows/visp-hyper-gate.yml";
      const existing = await readTextIfExists(destination);

      if (existing !== undefined) {
        if (!existing.includes(CI_WORKFLOW_MARKER)) {
          console.log(
            "warning: existing workflow found; not overwriting. Remove it to install the visp-hyper gate."
          );
          return;
        }
        if (!options.force) {
          console.log("hooks ci: up to date (use --force to rewrite)");
          return;
        }
      }

      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, CI_WORKFLOW, "utf8");
      console.log(
        `hooks ci: ${existing !== undefined ? "updated" : "installed"} ${relative}`
      );
    });
}

/**
 * Build the pre-commit hook body. Prefers a `visp-hyper` on PATH; otherwise falls
 * back to invoking the bundled `dist/index.js` directly so the hook works even
 * when the CLI is not globally installed.
 */
function gitHookContent(): string {
  // Single-quote the baked-in path so a directory containing $(...) or backticks
  // cannot be command-substituted by the shell; embedded single quotes are
  // escaped the POSIX way ('\'').
  const distPath = distIndexPath().replace(/'/gu, "'\\''");
  return `#!/bin/sh
${GIT_HOOK_MARKER}
# Blocks commits with files outside the active visp-hyper task scope.
if command -v visp-hyper >/dev/null 2>&1; then
  exec visp-hyper guard --staged
fi
exec node '${distPath}' guard --staged
`;
}

/**
 * Resolve the bundled `dist/index.js`. From `dist/index.js` itself this is the
 * running module; from `src/cli/commands/` during tests, walk upward to the
 * package root (a directory containing `dist/index.js`) and join — the package
 * always builds there. Mirrors the upward walk in tool-asset-installer.
 */
function distIndexPath(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let current = start;
  for (let depth = 0; depth <= 4; depth += 1) {
    const candidate = join(current, "dist", "index.js");
    if (existsSyncFile(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(
    `Could not locate dist/index.js starting from ${start}. Run \`pnpm build\` first.`
  );
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function existsSyncFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
