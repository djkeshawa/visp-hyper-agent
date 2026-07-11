import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectValidationRunner } from "../src/quality/validation-runner.js";

describe("ProjectValidationRunner", () => {
  describe("detect()", () => {
    it("AC001a: kitCommands wins over package.json", async () => {
      const runner = new ProjectValidationRunner({
        kitCommands: ["pnpm exec vitest run tests/x.test.ts"]
      });
      // Create a temp dir with a package.json that has scripts — should be ignored
      const dir = await mkdtemp(join(tmpdir(), "visp-val-"));
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }),
        "utf8"
      );
      await writeFile(join(dir, "pnpm-lock.yaml"), "", "utf8");

      const result = await runner.detect(dir);

      expect(result).toEqual(["pnpm exec vitest run tests/x.test.ts"]);
    });

    it("AC001b: package.json + pnpm-lock.yaml → ordered pnpm run commands (no lint)", async () => {
      const runner = new ProjectValidationRunner();
      const dir = await mkdtemp(join(tmpdir(), "visp-val-"));
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest", build: "tsc", lint: "eslint ." } }),
        "utf8"
      );
      await writeFile(join(dir, "pnpm-lock.yaml"), "", "utf8");

      const result = await runner.detect(dir);

      // order: test → typecheck → build → check; typecheck/check absent; lint excluded
      expect(result).toEqual(["pnpm run test", "pnpm run build"]);
    });

    it("config-declared commands extend the detected allowlist (deduped)", async () => {
      const runner = new ProjectValidationRunner({
        configCommands: ["pnpm run lint", "pnpm run test"]
      });
      const dir = await mkdtemp(join(tmpdir(), "visp-val-"));
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }),
        "utf8"
      );
      await writeFile(join(dir, "pnpm-lock.yaml"), "", "utf8");

      expect(await runner.detect(dir)).toEqual(["pnpm run test", "pnpm run lint"]);
    });

    it("config-declared commands survive a project without package.json", async () => {
      const runner = new ProjectValidationRunner({ configCommands: ["make check"] });
      const dir = await mkdtemp(join(tmpdir(), "visp-val-"));

      expect(await runner.detect(dir)).toEqual(["make check"]);
    });

    it("kitCommands still win over config-declared commands", async () => {
      const runner = new ProjectValidationRunner({
        kitCommands: ["pnpm exec vitest run tests/x.test.ts"],
        configCommands: ["pnpm run lint"]
      });
      const dir = await mkdtemp(join(tmpdir(), "visp-val-"));

      expect(await runner.detect(dir)).toEqual(["pnpm exec vitest run tests/x.test.ts"]);
    });

    it("AC001c: no package.json → empty array", async () => {
      const runner = new ProjectValidationRunner();
      const dir = await mkdtemp(join(tmpdir(), "visp-val-empty-"));

      const result = await runner.detect(dir);

      expect(result).toEqual([]);
    });
  });

  describe("run()", () => {
    it("AC002a: allowlisted command executes and returns exitCode 0", async () => {
      const runner = new ProjectValidationRunner({ kitCommands: ["node --version"] });
      const dir = await mkdtemp(join(tmpdir(), "visp-val-run-"));

      const results = await runner.run(dir, ["node --version"]);

      expect(results).toHaveLength(1);
      expect(results[0]!.exitCode).toBe(0);
      expect(results[0]!.output).toMatch(/^v\d+/);
    });

    it("AC002b: command NOT in allowlist → exitCode -1, message, no execution side-effects", async () => {
      const runner = new ProjectValidationRunner({ kitCommands: ["node --version"] });
      const dir = await mkdtemp(join(tmpdir(), "visp-val-run-"));

      const results = await runner.run(dir, ["pnpm run test"]);

      expect(results).toHaveLength(1);
      expect(results[0]!.exitCode).toBe(-1);
      expect(results[0]!.output).toMatch(/not in detected allowlist/);
    });

    it("AC002c: failing command returns the process exit code", async () => {
      const runner = new ProjectValidationRunner({
        kitCommands: ["node -e process.exit(3)"]
      });
      const dir = await mkdtemp(join(tmpdir(), "visp-val-run-"));

      const results = await runner.run(dir, ["node -e process.exit(3)"]);

      expect(results).toHaveLength(1);
      expect(results[0]!.exitCode).toBe(3);
    });

    it("AC002d: a command whose binary cannot be spawned records exitCode null + spawnError", async () => {
      const command = "definitely-not-a-real-binary-xyz --version";
      const runner = new ProjectValidationRunner({ kitCommands: [command] });
      const dir = await mkdtemp(join(tmpdir(), "visp-val-run-"));

      const results = await runner.run(dir, [command]);

      expect(results).toHaveLength(1);
      // Distinct from a real non-zero exit: null signals "could not be run".
      expect(results[0]!.exitCode).toBeNull();
      expect(results[0]!.spawnError).toBeTruthy();
      expect(results[0]!.output).toMatch(/could not be run/u);
    });
  });
});
