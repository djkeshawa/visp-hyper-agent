// P10-US-05/08: the machine-scope boundary.
//
// `setup` and `doctor` are the only verbs allowed to load the Visp Dev
// machine-scope adapter (visp-dev ADR 0001, accepted D-116). Project verbs
// never resolve it — a test enforces that. The adapter is loaded dynamically
// so a project-verb import graph can never pull it in by accident.

export const MACHINE_ADAPTER_SPECIFIER = "visp-dev/machine-scope";

type MachineScopeAdapter = {
  readonly runSetup: (input: {
    readonly projectPath: string;
    readonly args: readonly string[];
  }) => Promise<{ readonly success: boolean; readonly report: string }>;
};

async function loadAdapter(): Promise<MachineScopeAdapter | null> {
  try {
    const loaded = (await import(MACHINE_ADAPTER_SPECIFIER)) as Partial<MachineScopeAdapter>;
    if (typeof loaded.runSetup === "function") return loaded as MachineScopeAdapter;
    return null;
  } catch {
    return null;
  }
}

export async function runSetupVerb(projectPath: string, args: readonly string[]): Promise<void> {
  const adapter = await loadAdapter();
  if (adapter === null) {
    console.error(
      [
        "visp setup needs the Visp Dev machine-scope adapter, which is not installed.",
        "Install it with: npm install -g visp-dev",
        "Then re-run: visp setup"
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }
  const result = await adapter.runSetup({ projectPath, args });
  console.log(result.report);
  if (!result.success) process.exitCode = 1;
}
