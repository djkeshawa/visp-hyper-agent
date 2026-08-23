// The PATH-twin farm: sanitised copies of the PATH directories that provide an
// ambient Visp toolchain. `isolate-installed-visp.ts` explains WHY the suite
// needs them; this file owns WHICH twin a directory gets and whether a twin
// already on disk may be reused.
//
// THE CACHE IS THE WHOLE DIFFICULTY
//
// The farm lives at a stable path in `os.tmpdir()` so the twins are built once
// and shared by every worker — and, unavoidably, by every earlier run on the
// machine. So a twin found on disk is evidence of nothing until something ties
// it to the directory it claims to stand in for.
//
// It used to be tied to nothing at all. Twins were named `dir-${index}` after
// the source directory's POSITION IN PATH, and a name that already existed was
// returned unread:
//
//     const twin = join(FARM_ROOT, `dir-${index}`);
//     if (existsSync(twin)) return twin;
//
// Remove or insert one PATH entry and every later entry renumbers, so `dir-3`
// is whatever directory happened to sit third the last time anything ran. The
// twin of a different directory is then substituted for this one: a tool the
// run needs silently disappears from PATH, or the ambient Kit this file exists
// to remove survives, and in both cases the run looks completely normal. That
// is not a hypothetical — a `visp-dev` probe reported the same project-scope
// route under both of its conditions, because the "installed" run reused a twin
// built during the stripped run.
//
// `existsSync` was the second half of the same mistake. A twin interrupted
// after `mkdirSync` but before its links were written is `existsSync`-true
// forever, so a crashed run poisons every run after it with a permanently empty
// directory that reads as a valid twin.
//
// PROVE FRESHNESS, DO NOT ASSUME IT — the rule `build-dist.ts` already states
// for `dist/`, which refuses to check `existsSync(dist/index.js)` first because
// that accepts a stale artifact. Here it takes three parts:
//
//   1. The twin is named after a digest of its RECEIPT — the absolute source
//      directory, the mtime that changes whenever that directory's entry set
//      changes, and the set of binaries being shadowed. Position in PATH is not
//      an input, so no amount of reordering can collide.
//   2. A twin is reused only when the receipt written inside it MATCHES. The
//      digest separates the cache; the receipt verifies the hit. An empty
//      directory carries no receipt and is therefore never mistaken for a twin.
//   3. A twin is published by renaming a fully built staging directory into
//      place, so no other worker — and no later run — can ever observe a
//      half-built one.
//
// A failure to build a twin aborts the run. The alternative is measuring the
// wrong engine and calling it a result, which is the defect this whole file
// exists to prevent.

import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/**
 * Binaries whose ambient presence changes what the suite tests.
 *
 * `visp-memory` is deliberately NOT here: the memory contract test drives the
 * real binary on purpose.
 */
export const SHADOWED_BINARIES: ReadonlySet<string> = new Set(["visp", "visp-kit", "visp-hyper"]);

/**
 * Where twins live. Stable, so the farm is built once and shared across
 * workers — which is safe only because a twin's identity is now derived from
 * its source rather than from its position in this run's PATH.
 */
export const DEFAULT_FARM_ROOT = join(tmpdir(), "visp-hyper-test-path");

/** Written last, inside the twin, and read before any twin is reused. */
const TWIN_RECEIPT = ".visp-twin.json";

/** What a twin claims about itself. Every field is part of its identity. */
interface TwinReceipt {
  /** The absolute directory this twin stands in for. */
  readonly source: string;
  /**
   * The source directory's mtime. A directory's mtime moves when an entry is
   * added or removed, which is exactly the change that would make a twin's set
   * of symlinks wrong — the contents of the files it links to are irrelevant,
   * because the twin links rather than copies.
   */
  readonly entriesChangedAt: number;
  /** Sorted, so two equal sets always produce one digest. */
  readonly shadowed: readonly string[];
}

function receiptFor(directory: string, shadowed: ReadonlySet<string>): TwinReceipt {
  return {
    source: directory,
    entriesChangedAt: statSync(directory).mtimeMs,
    shadowed: [...shadowed].sort()
  };
}

function twinPathFor(farmRoot: string, receipt: TwinReceipt): string {
  const digest = createHash("sha256").update(JSON.stringify(receipt)).digest("hex").slice(0, 16);
  return join(farmRoot, `dir-${digest}`);
}

/**
 * Whether `twin` is a complete twin built for exactly this receipt.
 *
 * Anything else — absent, a file, a directory with no receipt, a receipt that
 * does not parse, a receipt describing some other directory — is not a cache
 * hit. This is the assertion `existsSync` was standing in for and could not
 * make.
 */
function matchesReceipt(twin: string, expected: TwinReceipt): boolean {
  try {
    if (!statSync(twin).isDirectory()) return false;
    const actual = JSON.parse(readFileSync(join(twin, TWIN_RECEIPT), "utf8")) as TwinReceipt;
    return (
      actual.source === expected.source &&
      actual.entriesChangedAt === expected.entriesChangedAt &&
      Array.isArray(actual.shadowed) &&
      JSON.stringify(actual.shadowed) === JSON.stringify(expected.shadowed)
    );
  } catch {
    return false;
  }
}

function tryRename(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a fully built staging directory to `twin`, so a twin is either absent or
 * complete and never anything in between.
 *
 * The rename is attempted BEFORE anything is deleted, which is what makes this
 * safe under parallel workers. Every worker building this twin computed the
 * same receipt, so when one of them wins the others' renames fail, they
 * recognise the winner's twin as their own, and no worker ever unlinks a
 * directory another worker's PATH already points at. Deleting only happens for
 * something that is genuinely NOT this twin — debris from an interrupted run,
 * or a file where a directory belongs.
 */
function publish(staging: string, twin: string, receipt: TwinReceipt): void {
  // Also the half-built case: POSIX renames onto an existing EMPTY directory,
  // so a twin a crashed run left bare is replaced atomically.
  if (tryRename(staging, twin)) return;

  if (matchesReceipt(twin, receipt)) {
    rmSync(staging, { recursive: true, force: true });
    return;
  }

  rmSync(twin, { recursive: true, force: true });
  if (tryRename(staging, twin)) return;

  // Lost a race to a worker that got there between the delete and the rename.
  if (matchesReceipt(twin, receipt)) {
    rmSync(staging, { recursive: true, force: true });
    return;
  }
  throw new Error(`could not publish the sanitised twin at ${twin}`);
}

function buildTwin(directory: string, twin: string, receipt: TwinReceipt): void {
  const staging = `${twin}.building-${process.pid}-${randomBytes(6).toString("hex")}`;
  mkdirSync(staging, { recursive: true });
  try {
    const shadowed = new Set(receipt.shadowed);
    for (const entry of readdirSync(directory)) {
      if (shadowed.has(entry)) continue;
      try {
        symlinkSync(join(directory, entry), join(staging, entry));
      } catch (error) {
        // An entry that vanished between the listing and the link is a normal
        // race in a busy bin directory, and a link to it was never needed.
        // Every other failure means this twin would misrepresent its source,
        // so it must not become one.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    writeFileSync(join(staging, TWIN_RECEIPT), JSON.stringify(receipt), "utf8");
    publish(staging, twin, receipt);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function providesShadowedBinary(directory: string, shadowed: ReadonlySet<string>): boolean {
  try {
    return readdirSync(directory).some((entry) => shadowed.has(entry));
  } catch {
    return false;
  }
}

function sanitisedTwin(entry: string, farmRoot: string, shadowed: ReadonlySet<string>): string {
  try {
    const directory = resolve(entry);
    const receipt = receiptFor(directory, shadowed);
    const twin = twinPathFor(farmRoot, receipt);
    if (matchesReceipt(twin, receipt)) return twin;

    mkdirSync(farmRoot, { recursive: true });
    buildTwin(directory, twin, receipt);
    return twin;
  } catch (error) {
    throw new Error(
      `The test suite could not remove the installed Visp toolchain from the PATH entry ` +
        `"${entry}". Every test would then be driven by whatever Kit that directory ` +
        `provides instead of this repository's own build, so the run is aborted rather ` +
        `than reporting results measured against the wrong engine.\n` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export interface SanitisePathOptions {
  /** The PATH to sanitise, in `delimiter`-separated form. */
  readonly path: string;
  /** Where twins are kept. Tests pass a scratch directory. */
  readonly farmRoot?: string;
  /** Binary names to remove. Defaults to {@link SHADOWED_BINARIES}. */
  readonly shadowed?: ReadonlySet<string>;
}

/**
 * `path`, with every directory that provides a shadowed binary replaced by a
 * twin that provides everything else it held.
 *
 * Deliberately a scalpel: directories that provide none of the shadowed
 * binaries are passed through untouched, so `node`, `npm` and `visp-memory`
 * survive — the memory contract test requires the real `visp-memory` and fails
 * rather than skipping when it is missing.
 */
export function sanitisePath(options: SanitisePathOptions): string {
  const farmRoot = options.farmRoot ?? DEFAULT_FARM_ROOT;
  const shadowed = options.shadowed ?? SHADOWED_BINARIES;

  return options.path
    .split(delimiter)
    .filter(Boolean)
    .map((entry) =>
      providesShadowedBinary(entry, shadowed) ? sanitisedTwin(entry, farmRoot, shadowed) : entry
    )
    .join(delimiter);
}
