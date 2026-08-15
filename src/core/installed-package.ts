/**
 * Locating a globally installed package's subpath export from its PATH binary.
 *
 * Node resolves a bare specifier like `<pkg>/<subpath>` against the *importer's*
 * node_modules chain. A package installed with `npm install -g` is not on that
 * chain, so the import fails even though the command it ships is on PATH and
 * runs. This module answers the question the failed import cannot: given a
 * command that exists, where does its package live, and what file does the
 * subpath export point at?
 *
 * It reads `package.json` and touches disk. It never executes the binary.
 */

import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { findExecutableOnPath } from "./executable-resolver.js";

/**
 * How far above the binary to look for the package root. A global install puts
 * it one or two levels up; anything deeper is a directory that happens to sit
 * above an unrelated PATH entry, and following it would be guessing.
 */
const SEARCH_DEPTH = 6;

/** Conditional export keys, in the order an ESM import would pick them. */
const IMPORT_CONDITIONS = ["import", "node", "default"] as const;

/**
 * How deeply conditional export objects may nest before the value is treated as
 * unresolvable. Real manifests nest two or three deep; a cap keeps a cyclic or
 * hostile manifest from driving the recursion.
 */
const MAX_CONDITION_NESTING = 6;

export type InstalledPackageQuery = {
  /** Command name to find on PATH. */
  readonly binary: string;
  /** `name` the package must declare, so a namesake directory cannot match. */
  readonly packageName: string;
  /** Subpath export to resolve, e.g. `"./machine-scope"`. */
  readonly subpath: string;
};

/**
 * The absolute file the subpath export points at, or `null` when the package
 * is not installed, is not the one asked for, or exports no such subpath.
 */
export async function resolveInstalledPackageExport(
  query: InstalledPackageQuery
): Promise<string | null> {
  const binaryPath = await findExecutableOnPath(query.binary);
  if (binaryPath === null) return null;

  const root = await packageRoot(await canonicalPath(binaryPath), query.packageName);
  if (root === null) return null;

  const target = exportTarget(await readManifest(root), query.subpath);
  if (target === null) return null;

  const file = resolve(root, target);
  return (await exists(file)) ? file : null;
}

/**
 * The directory above `binaryPath` whose package.json declares `packageName`.
 *
 * Two layouts are searched at every level because global installs differ by
 * platform: POSIX symlinks the bin into place, so the real path already sits
 * inside the package, while a win32 shim sits in the prefix directory beside
 * `node_modules/<pkg>/`.
 */
async function packageRoot(binaryPath: string, packageName: string): Promise<string | null> {
  let directory = dirname(binaryPath);

  for (let level = 0; level < SEARCH_DEPTH; level += 1) {
    for (const candidate of [directory, join(directory, "node_modules", packageName)]) {
      const manifest = await readManifest(candidate);
      if (manifest?.name === packageName) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * Follow symlinks so a POSIX global bin resolves into the package it belongs
 * to. A path that cannot be canonicalised is used as-is rather than discarded.
 */
async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}

type PackageManifest = {
  readonly name?: unknown;
  readonly exports?: unknown;
};

async function readManifest(directory: string): Promise<PackageManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function exportTarget(manifest: PackageManifest | null, subpath: string): string | null {
  const map = manifest?.exports;
  return isRecord(map) ? conditionalTarget(map[subpath]) : null;
}

/** Unwrap `"./file.js"` or `{ import: "./file.js" }`, however deeply nested. */
function conditionalTarget(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return value;
  if (depth >= MAX_CONDITION_NESTING || !isRecord(value)) return null;

  for (const condition of IMPORT_CONDITIONS) {
    const resolved = conditionalTarget(value[condition], depth + 1);
    if (resolved !== null) return resolved;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}
