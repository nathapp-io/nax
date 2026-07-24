export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export interface Finding {
  severity: Severity;
  title: string;
  problem: string;
  fix: string;
}
export interface ReviewVerdict {
  route: "proceed" | "escalate";
  findings: Finding[];
  escalationReason?: string;
}
export interface FinishInput {
  feature: string;
  workdir: string;
  branch: string;
  prdPath: string;
  escalateTelegram: boolean;
}
export interface FinishResult {
  feature: string;
  status: "opened" | "promoted" | "already-ready" | "escalated" | "nothing-to-finish";
  url?: string;
  escalationReason?: string;
}
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type RunFn = (cmd: string[], opts: { cwd: string }) => Promise<RunResult>;
