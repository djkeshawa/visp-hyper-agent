import { statSync } from "node:fs";
import { chmod, lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { execFileResolved } from "../../core/executable-resolver.js";
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
      let resolvedHook: ResolvedGitHook;
      try {
        resolvedHook = await resolveGitHook(projectPath);
      } catch (error) {
        if (error instanceof UnsafeHookPathError) {
          console.error(`error: ${error.message}`);
        } else {
          console.error("error: not a git repository (run inside a project with .git).");
        }
        process.exitCode = 1;
        return;
      }

      const hookPath = resolvedHook.absolutePath;
      const existing = await readTextIfExists(hookPath);

      if (existing !== undefined && !existing.includes(GIT_HOOK_MARKER)) {
        console.log(
          "warning: existing pre-commit hook found; not overwriting. Chain `visp-hyper guard --staged` manually."
        );
        return;
      }

      const updating = existing !== undefined;
      await mkdir(resolvedHook.hooksDirectory, { recursive: true });
      await writeFile(hookPath, gitHookContent(), "utf8");
      await chmod(hookPath, 0o755);
      console.log(
        `hooks git: ${updating ? "updated" : "installed"} ${resolvedHook.displayPath}`
      );
    });
}

type ResolvedGitHook = {
  absolutePath: string;
  hooksDirectory: string;
  displayPath: string;
};

class UnsafeHookPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeHookPathError";
  }
}

async function resolveGitHook(projectPath: string): Promise<ResolvedGitHook> {
  const inside = await execFileResolved("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: projectPath
  });
  if (inside.stdout.trim() !== "true") {
    throw new Error("not a Git worktree");
  }

  const [hookResult, commonDirResult] = await Promise.all([
    execFileResolved(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"],
      { cwd: projectPath }
    ),
    execFileResolved("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: projectPath
    })
  ]);

  const hookPath = parseAbsoluteGitPath(hookResult.stdout, "hook");
  const commonDir = parseAbsoluteGitPath(commonDirResult.stdout, "common directory");
  const [projectRoot, gitCommonRoot, canonicalHook] = await Promise.all([
    realpath(resolve(projectPath)),
    realpath(commonDir),
    canonicalWritePath(hookPath)
  ]);

  if (!isContained(projectRoot, canonicalHook) && !isContained(gitCommonRoot, canonicalHook)) {
    throw new UnsafeHookPathError(
      `refusing Git hook path outside the project and repository metadata: ${hookPath}`
    );
  }

  return {
    absolutePath: canonicalHook,
    hooksDirectory: dirname(canonicalHook),
    displayPath: displayHookPath(projectPath, hookPath)
  };
}

function parseAbsoluteGitPath(output: string, label: string): string {
  const value = output.replace(/\r?\n$/u, "");
  if (!value || /[\0\r\n]/u.test(value) || !isAbsolute(value)) {
    throw new UnsafeHookPathError(`Git returned an invalid ${label} path`);
  }
  return resolve(value);
}

async function canonicalWritePath(candidate: string): Promise<string> {
  const missingSegments: string[] = [];
  let cursor = candidate;

  while (true) {
    try {
      await lstat(cursor);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new UnsafeHookPathError("Git hook path has no accessible parent");
      }
      missingSegments.unshift(basename(cursor));
      cursor = parent;
      continue;
    }

    let canonicalParent: string;
    try {
      canonicalParent = await realpath(cursor);
    } catch {
      throw new UnsafeHookPathError("Git hook path contains an unreadable or dangling symlink");
    }
    const canonicalInfo = await stat(canonicalParent);
    if (missingSegments.length > 0 && !canonicalInfo.isDirectory()) {
      throw new UnsafeHookPathError("Git hook path has a non-directory parent");
    }
    if (missingSegments.length === 0 && !canonicalInfo.isFile()) {
      throw new UnsafeHookPathError("Git hook path is not a regular file");
    }
    return join(canonicalParent, ...missingSegments);
  }
}

function displayHookPath(projectPath: string, hookPath: string): string {
  const projectRoot = resolve(projectPath);
  if (isContained(projectRoot, hookPath)) {
    return relative(projectRoot, hookPath).replaceAll("\\", "/");
  }
  return hookPath;
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const relation = relative(rootPath, candidatePath);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
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

function existsSyncFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
