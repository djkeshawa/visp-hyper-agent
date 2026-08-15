/**
 * The shape of a Doctor result.
 *
 * Every check returns the same record, so the summary can be rendered and the
 * exit code decided without knowing which check produced which line.
 */

export type DoctorStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  recovery?: string;
};

export type DoctorSummary = {
  success: boolean;
  projectPath: string;
  version: string;
  checks: DoctorCheck[];
  nextCommand: string;
};
