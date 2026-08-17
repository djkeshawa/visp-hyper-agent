/**
 * The shape of a Doctor result.
 *
 * Every check returns the same record, so the summary can be rendered and the
 * exit code decided without knowing which check produced which line.
 */

export type DoctorStatus = "pass" | "warn" | "fail";

/**
 * What the `Overall:` line may say. `inconclusive` is the state LC-97 had no
 * word for: nothing is broken, and Doctor still cannot certify the project.
 * `./verdict.ts` owns which findings reach this.
 */
export type DoctorVerdict = "pass" | "inconclusive" | "fail";

export type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  recovery?: string;
};

export type DoctorSummary = {
  /**
   * Whether Doctor can vouch for this project — the machine mirror of
   * `verdict`, true only when the verdict is `pass`. It used to mean "no check
   * failed", which is why a machine reader gating on it was told PASS over a
   * report saying the work was never coordinated.
   */
  success: boolean;
  verdict: DoctorVerdict;
  projectPath: string;
  version: string;
  checks: DoctorCheck[];
  nextCommand: string;
};
