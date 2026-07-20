import { readdir, readFile } from "node:fs/promises";
import { fileExists } from "../core/fs-utils.js";
import { resolveProjectFile } from "../core/project-path.js";
import { join } from "node:path";
import type { KitTask, KitTaskGraph } from "../kit/kit-schemas.js";

/**
 * Result of a best-effort plan-file read. `graph` is `null` when nothing
 * parseable was found; `source` identifies which plan file produced the graph
 * (e.g. `"TODO.md"`, `"spec-kit:001-foo/tasks.md"`); `warnings` collects every
 * non-fatal note (files that existed but yielded nothing, ignored alternative
 * sources, IO failures). These readers never throw.
 */
export type PlanGraphResult = {
  graph: KitTaskGraph | null;
  source: string | null;
  warnings: string[];
  failureReason?: "missing" | "invalid-source" | "invalid-content";
};

const CHECKLIST_LINE = /^(\s*)[-*] \[( |x|X)\] (.+)$/;
const SPEC_KIT_ID = /^(T\d+)\b\s*/;

function padId(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(3, "0")}`;
}

function leadingWidth(indent: string): number {
  // Treat a tab as a single column; we only need relative comparisons.
  return indent.replace(/\t/g, " ").length;
}

/**
 * Turn a markdown checklist into tasks, in document order. Each line matching
 * `- [ ] text` / `- [x] text` (or `*`) becomes a task. Checked items map to
 * `verified`, unchecked to `pending`. Tasks chain linearly via `dependsOn`
 * (each depends on the previous one; the first has none). Indented, non-
 * checklist continuation lines that follow an item become its `description`.
 * All other lines are ignored. Zero items yields `[]`.
 */
export function parseChecklist(content: string, options?: { idPrefix?: string }): KitTask[] {
  const prefix = options?.idPrefix ?? "P";
  const lines = content.split(/\r?\n/);

  type Pending = {
    title: string;
    checked: boolean;
    indentWidth: number;
    descriptionLines: string[];
  };

  const items: Pending[] = [];

  for (const line of lines) {
    const match = CHECKLIST_LINE.exec(line);
    if (match) {
      const indent = match[1] ?? "";
      const mark = match[2] ?? " ";
      const text = (match[3] ?? "").trim();
      items.push({
        title: text,
        checked: mark === "x" || mark === "X",
        indentWidth: leadingWidth(indent),
        descriptionLines: []
      });
      continue;
    }

    if (items.length === 0) {
      continue;
    }

    const current = items[items.length - 1];
    if (!current) {
      continue;
    }

    // A continuation line is non-blank and indented deeper than its owning item.
    if (line.trim().length === 0) {
      continue;
    }
    const indentWidth = leadingWidth(line.match(/^\s*/)?.[0] ?? "");
    if (indentWidth > current.indentWidth) {
      current.descriptionLines.push(line.trim());
    }
  }

  return items.map((item, index) => {
    const description =
      item.descriptionLines.length > 0 ? item.descriptionLines.join(" ") : undefined;
    const task: KitTask = {
      id: padId(prefix, index + 1),
      title: item.title,
      status: item.checked ? "verified" : "pending",
      dependsOn: index === 0 ? [] : [padId(prefix, index)],
      ...(description ? { description } : {})
    };
    return task;
  });
}

/**
 * Parse checklist lines where an item may already carry its own id, e.g.
 * `- [ ] T001 Create the schema`. When present that id is used and stripped
 * from the title; otherwise ids fall back to the `idPrefix` sequence.
 */
function parseIdedChecklist(content: string, idPrefix: string): KitTask[] {
  const base = parseChecklist(content, { idPrefix });
  return base.map((task, index) => {
    const idMatch = SPEC_KIT_ID.exec(task.title ?? "");
    if (!idMatch) {
      return task;
    }
    const explicitId = idMatch[1]!;
    const title = (task.title ?? "").replace(SPEC_KIT_ID, "").trim();
    // Dependencies are left as-is here (only the first task is forced to none);
    // the actual re-linking to each prior task's explicit id happens later in
    // relinkDependencies().
    const dependsOn = index === 0 ? [] : task.dependsOn;
    return { ...task, id: explicitId, title, dependsOn };
  });
}

/**
 * Re-link `dependsOn` so each task points at the prior task's final id. Needed
 * after explicit ids replace the synthetic sequence in {@link parseIdedChecklist}.
 */
function relinkDependencies(tasks: KitTask[]): KitTask[] {
  return tasks.map((task, index) => ({
    ...task,
    dependsOn: index === 0 ? [] : [tasks[index - 1]!.id]
  }));
}

async function tryReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function tryReadProjectFile(projectPath: string, relativePath: string): Promise<string | null> {
  try {
    const resolved = await resolveProjectFile(projectPath, relativePath, {
      mode: "read",
      blockedPaths: []
    });
    return await readFile(resolved.absolutePath, "utf8");
  } catch {
    return null;
  }
}

const GENERIC_CANDIDATES = ["PLAN.md", "TODO.md", "tasks.md"];

function genericGraphResult(fileName: string, content: string): PlanGraphResult {
  const tasks = parseChecklist(content, { idPrefix: "P" });
  if (tasks.length === 0) {
    return {
      graph: null,
      source: fileName,
      warnings: [`no checklist items found in ${fileName}`],
      failureReason: "invalid-content"
    };
  }
  return {
    graph: { featureSlug: fileName, tasks },
    source: fileName,
    warnings: []
  };
}

/**
 * Probe `PLAN.md`, `TODO.md`, `tasks.md` (in that order) at the project root.
 * The first file that exists and yields ≥1 task wins. Files that exist but
 * contain no checklist items produce a warning and the probe continues.
 */
export async function readGenericChecklist(projectPath: string): Promise<PlanGraphResult> {
  const warnings: string[] = [];

  for (const fileName of GENERIC_CANDIDATES) {
    const content = await tryReadFile(join(projectPath, fileName));
    if (content === null) {
      continue;
    }
    const result = genericGraphResult(fileName, content);
    if (!result.graph) {
      warnings.push(...result.warnings);
      continue;
    }
    return { ...result, warnings };
  }

  return { graph: null, source: null, warnings };
}

/**
 * Among `<root>/<changesSubpath>/<dir>/tasks.md`, pick the last directory in
 * sorted order (highest feature number). Returns the chosen dir + its content
 * plus any warnings about ignored alternatives. Missing layout → `null` dir.
 */
async function selectLatestTasksFile(
  containerRoot: string,
  warnLabel: string
): Promise<{ dir: string; content: string; warnings: string[] } | { dir: null; warnings: string[] }> {
  const warnings: string[] = [];

  let dirNames: string[];
  try {
    const entries = await readdir(containerRoot, { withFileTypes: true });
    dirNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { dir: null, warnings };
  }

  const withTasks: string[] = [];
  for (const dir of dirNames) {
    if (await fileExists(join(containerRoot, dir, "tasks.md"))) {
      withTasks.push(dir);
    }
  }

  if (withTasks.length === 0) {
    return { dir: null, warnings };
  }

  const chosen = withTasks[withTasks.length - 1]!;
  for (const ignored of withTasks.slice(0, -1)) {
    warnings.push(`ignored ${warnLabel}:${ignored}/tasks.md`);
  }

  const content = await tryReadFile(join(containerRoot, chosen, "tasks.md"));
  if (content === null) {
    return { dir: null, warnings };
  }

  return { dir: chosen, content, warnings };
}

function idedGraphResult(
  dir: string,
  content: string,
  warnings: string[],
  sourcePrefix: string
): PlanGraphResult {
  const tasks = relinkDependencies(parseIdedChecklist(content, "T"));
  if (tasks.length === 0) {
    warnings.push(`no checklist items found in ${sourcePrefix}:${dir}/tasks.md`);
    return { graph: null, source: null, warnings };
  }
  const graph: KitTaskGraph = { featureSlug: dir, tasks };
  return { graph, source: `${sourcePrefix}:${dir}/tasks.md`, warnings };
}

/**
 * Re-read one previously discovered plan source exactly. Unlike discovery,
 * this function never probes another generic file or chooses a newer feature
 * directory when the requested source is missing or invalid.
 */
export async function readPlanTaskGraphSource(
  projectPath: string,
  source: string
): Promise<PlanGraphResult> {
  if (GENERIC_CANDIDATES.includes(source)) {
    const content = await tryReadProjectFile(projectPath, source);
    if (content === null) {
      return {
        graph: null,
        source,
        warnings: [`plan source is missing or unreadable: ${source}`],
        failureReason: "missing"
      };
    }
    return genericGraphResult(source, content);
  }

  const tagged = /^(spec-kit|openspec):([^/\\]+)\/tasks\.md$/u.exec(source);
  const kind = tagged?.[1];
  const dir = tagged?.[2];
  if (!kind || !dir || dir === "." || dir === "..") {
    return {
      graph: null,
      source,
      warnings: [`unsupported exact plan source: ${source}`],
      failureReason: "invalid-source"
    };
  }

  const relativePath =
    kind === "spec-kit"
      ? join("specs", dir, "tasks.md")
      : join("openspec", "changes", dir, "tasks.md");
  const content = await tryReadProjectFile(projectPath, relativePath);
  if (content === null) {
    return {
      graph: null,
      source,
      warnings: [`plan source is missing or unreadable: ${source}`],
      failureReason: "missing"
    };
  }

  const result = idedGraphResult(dir, content, [], kind);
  if (!result.graph) {
    return { ...result, source, failureReason: "invalid-content" };
  }
  return result;
}

/**
 * GitHub Spec Kit layout: `specs/<feature-dir>/tasks.md`. When several feature
 * dirs carry a `tasks.md`, the last sorted (newest numbered) wins and the rest
 * are warned about. Item ids embedded in the text (`- [ ] T001 ...`) are used.
 */
export async function readSpecKit(projectPath: string): Promise<PlanGraphResult> {
  const selection = await selectLatestTasksFile(join(projectPath, "specs"), "spec-kit");
  if (selection.dir === null) {
    return { graph: null, source: null, warnings: selection.warnings };
  }
  return idedGraphResult(selection.dir, selection.content, selection.warnings, "spec-kit");
}

/**
 * OpenSpec layout: `openspec/changes/<change-dir>/tasks.md`. Same selection and
 * parsing rules as the Spec Kit reader; sources are prefixed `openspec:`.
 */
export async function readOpenSpec(projectPath: string): Promise<PlanGraphResult> {
  const selection = await selectLatestTasksFile(
    join(projectPath, "openspec", "changes"),
    "openspec"
  );
  if (selection.dir === null) {
    return { graph: null, source: null, warnings: selection.warnings };
  }
  return idedGraphResult(selection.dir, selection.content, selection.warnings, "openspec");
}

/**
 * Best-effort discovery across all plan-file conventions. Tries generic →
 * Spec Kit → OpenSpec; the first reader to produce a graph wins. If a later
 * reader would also have matched, a `ignored plan source: <source>` warning is
 * appended. Warnings from every attempted reader are merged. Never throws.
 */
export async function discoverPlanTaskGraph(projectPath: string): Promise<PlanGraphResult> {
  const generic = await readGenericChecklist(projectPath);
  const specKit = await readSpecKit(projectPath);
  const openSpec = await readOpenSpec(projectPath);

  const attempts = [generic, specKit, openSpec];
  const warnings: string[] = [];
  for (const attempt of attempts) {
    warnings.push(...attempt.warnings);
  }

  const winner = attempts.find((attempt) => attempt.graph !== null) ?? null;
  if (!winner) {
    return { graph: null, source: null, warnings };
  }

  for (const attempt of attempts) {
    if (attempt === winner) {
      continue;
    }
    if (attempt.graph !== null && attempt.source) {
      warnings.push(`ignored plan source: ${attempt.source}`);
    }
  }

  return { graph: winner.graph, source: winner.source, warnings };
}
