import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectVisp, KitCommandBridge } from "../src/kit/kit-command-bridge.js";
import {
  kitContextPackSchema,
  kitGateResultSchema,
  kitStatusSchema
} from "../src/kit/kit-schemas.js";
import { createVispShim } from "./helpers/visp-shim.js";

const initializedStatus = {
  success: true,
  initialized: true,
  activeFeature: { id: "002", slug: "demo", key: "002-demo" },
  activeTask: { id: "T001", title: "Kit Schemas", status: "ready" },
  featureState: "context_ready",
  // Extra unknown fields that real visp output includes:
  targetPath: "/somewhere",
  taskSummary: { total: 2, ready: 1 }
};

describe("detectVisp", () => {
  it("AC001: returns available with parsed status for an initialized kit", async () => {
    const shim = await createVispShim({ status: { stdout: initializedStatus } });

    const result = await detectVisp(process.cwd(), { binary: shim.binary });

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.status.initialized).toBe(true);
      expect(result.status.activeTask?.id).toBe("T001");
    }
  });

  it("AC002a: returns unavailable (no throw) when the binary does not exist", async () => {
    const result = await detectVisp(process.cwd(), {
      binary: join(tmpdir(), "definitely-not-a-real-visp-binary-xyz")
    });

    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/not found|unavailable/i);
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });

  it("AC002b: returns unavailable when the binary exits non-zero with garbage", async () => {
    const shim = await createVispShim({ status: { stdout: "not json at all", exitCode: 1 } });

    const result = await detectVisp(process.cwd(), { binary: shim.binary });

    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });

  it("AC002d: returns unavailable when only visp-hyper's own .visp/hyper exists (no kit artifacts)", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-nokit-"));
    await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
    // Shim would say initialized=true, but without policy.json/project.json the
    // probe must not even be trusted.
    const shim = await createVispShim({ status: { stdout: initializedStatus } });

    const result = await detectVisp(projectPath, { binary: shim.binary });

    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/no visp kit artifacts/i);
    }
  });

  it("AC002c: returns unavailable when the kit is not initialized", async () => {
    const shim = await createVispShim({
      status: { stdout: { success: true, initialized: false } }
    });

    const result = await detectVisp(process.cwd(), { binary: shim.binary });

    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/not initialized/i);
    }
  });
});

describe("KitCommandBridge", () => {
  it("AC003: parses status/verify/review/reconcile/next and passes --json", async () => {
    const shim = await createVispShim({
      status: { stdout: initializedStatus },
      verify: { stdout: { success: true, warnings: ["w"] } },
      review: { stdout: { success: true, errors: [] } },
      reconcile: { stdout: { success: false, errors: ["e"] } },
      next: { stdout: { success: true, nextCommand: "visp pr", state: "ready", allowed: true } }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect((await bridge.status())?.initialized).toBe(true);
    expect((await bridge.verify())?.warnings).toEqual(["w"]);
    expect((await bridge.review())?.success).toBe(true);
    expect((await bridge.reconcile())?.errors).toEqual(["e"]);
    expect((await bridge.next())?.nextCommand).toBe("visp pr");
    expect(bridge.warnings).toEqual([]);

    const log = await readFile(shim.argvLogPath, "utf8");
    for (const line of log.trim().split("\n")) {
      expect(JSON.parse(line)).toContain("--json");
    }
  });

  it("AC004: gate exiting non-zero with valid JSON returns allowed=false without throwing", async () => {
    const shim = await createVispShim({
      gate: {
        stdout: {
          success: false,
          stage: "implement",
          allowed: false,
          failedRules: [{ ruleId: "VSP006", severity: "error", message: "blocked" }],
          blockedCommands: [{ command: "visp pr", reason: "missing verify", ruleId: "VSP014" }]
        },
        exitCode: 1
      }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.gateImplement("T001");

    expect(result?.allowed).toBe(false);
    expect(result?.failedRules[0]?.ruleId).toBe("VSP006");
    expect(bridge.warnings).toEqual([]);

    // The real CLI takes the task as a flag; a positional id is parsed as a path.
    const argv = JSON.parse((await readFile(shim.argvLogPath, "utf8")).trim()) as string[];
    expect(argv).toEqual(["gate", "implement", "--task", "T001", "--json"]);
  });

  it("AC003: verify/review/reconcile pass the task id as a --task flag", async () => {
    const shim = await createVispShim({
      verify: { stdout: { success: true } },
      review: { stdout: { success: true } }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    await bridge.verify("T009");
    await bridge.review("T009");

    const lines = (await readFile(shim.argvLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(lines[0]).toEqual(["verify", "--task", "T009", "--json"]);
    expect(lines[1]).toEqual(["review", "--task", "T009", "--json"]);
  });

  it("AC005: unparseable output yields null plus a warning, no exception", async () => {
    const shim = await createVispShim({ verify: { stdout: "<<< not json >>>" } });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.verify();

    expect(result).toBeNull();
    expect(bridge.warnings.length).toBeGreaterThan(0);
  });

  it("AC005: gateImplement fails closed on non-JSON gate output (returns null + schema-parse warning)", async () => {
    // Invariant: "unparseable gate results fail closed". A gate is the security
    // boundary, so unparseable output must NOT be treated as allowed.
    const shim = await createVispShim({ gate: { stdout: "<<not json>>" } });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.gateImplement("T001");

    expect(result).toBeNull();
    expect(
      bridge.warnings.some((warning) =>
        warning.includes("could not be parsed against the expected schema")
      )
    ).toBe(true);
  });

  it("AC005: gateImplement fails closed on valid JSON with the wrong shape (schema mismatch)", async () => {
    // `allowed` must be a boolean; the string "yes" violates the schema, so the
    // gate must fail closed (null) rather than coercing a truthy value to allowed.
    const shim = await createVispShim({ gate: { stdout: { allowed: "yes" } } });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.gateImplement("T001");

    expect(result).toBeNull();
  });

  it("AC005: gateImplement returns the parsed result for a well-formed allowed gate body", async () => {
    // Sanity: proves the negative cases above are meaningful — a valid body parses
    // through to a non-null result with allowed === true.
    const shim = await createVispShim({
      gate: { stdout: { success: true, stage: "implement", allowed: true } }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.gateImplement("T001");

    expect(result).not.toBeNull();
    expect(result?.allowed).toBe(true);
    expect(bridge.warnings).toEqual([]);
  });

  it("AC003: recordBudget sends the visp budget flags", async () => {
    const shim = await createVispShim({ budget: { stdout: { success: true } } });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const recorded = await bridge.recordBudget({
      taskId: "T001",
      inputTokens: 1200,
      outputTokens: 300,
      model: "claude-code",
      note: "implementation pass"
    });
    expect(recorded?.success).toBe(true);

    const unavailable = await bridge.recordBudget({ taskId: "T002", unavailable: true });
    expect(unavailable?.success).toBe(true);

    const lines = (await readFile(shim.argvLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(lines[0]).toEqual([
      "budget",
      "--task",
      "T001",
      "--record-usage",
      "--input-tokens",
      "1200",
      "--output-tokens",
      "300",
      "--model",
      "claude-code",
      "--usage-note",
      "implementation pass",
      "--json"
    ]);
    expect(lines[1]).toEqual(["budget", "--task", "T002", "--record-usage-unavailable", "--json"]);
  });

  it("AC003: readContextPack reads and parses a fixture context pack file", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-ctx-"));
    const contextDir = join(projectPath, ".visp", "features", "001-x", "context");
    await mkdir(contextDir, { recursive: true });
    await writeFile(
      join(contextDir, "T001.context.json"),
      JSON.stringify({
        taskId: "T001",
        includedFiles: [{ path: "src/kit/kit-schemas.ts", reason: "new file" }],
        validationCommands: ["pnpm typecheck"],
        // unknown extra field:
        strictnessMode: "strict"
      }),
      "utf8"
    );

    // status responds with no active feature so the scan path is exercised.
    const shim = await createVispShim({
      status: { stdout: { success: true, initialized: true } }
    });
    const bridge = new KitCommandBridge({ projectPath, binary: shim.binary });

    const pack = await bridge.readContextPack("T001");

    expect(pack?.taskId).toBe("T001");
    expect(pack?.includedFiles?.[0]?.path).toBe("src/kit/kit-schemas.ts");
    expect(bridge.warnings).toEqual([]);
  });
});

describe("kit-schemas tolerance (AC006)", () => {
  it("parses realistic status payloads with extra unknown fields", () => {
    const parsed = kitStatusSchema.safeParse(initializedStatus);
    expect(parsed.success).toBe(true);
  });

  it("normalizes failedRules given as bare strings", () => {
    const parsed = kitGateResultSchema.safeParse({
      success: true,
      stage: "feature",
      allowed: true,
      failedRules: ["VSP018"],
      passedRules: ["VSP001"],
      reportPath: ".visp/reports/gate-report.md"
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.failedRules[0]?.ruleId).toBe("VSP018");
    }
  });

  it("parses context packs with includedFiles and unknown fields", () => {
    const parsed = kitContextPackSchema.safeParse({
      id: "CTX-T001",
      featureId: "002",
      taskId: "T001",
      includedFiles: [{ path: "a.ts", reason: "x", includeMode: "new-file" }],
      includedSnippets: [],
      validationCommands: ["pnpm test"]
    });
    expect(parsed.success).toBe(true);
  });
});
