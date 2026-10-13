/** Which files are nax run state (#2497). Pure: no IO. */
import { PROJECT_FEATURES_DIR } from "@/config/paths";

export type RunStateKind = "prd" | "status" | "workflow-result" | "ledger" | "decisions";

export interface RunStatePath {
  /** The directory holding `.nax/`, absolute. */
  readonly root: string;
  readonly feature: string;
  readonly kind: RunStateKind;
  /** Root-relative, `/`-joined. */
  readonly rel: string;
}

const FEATURE_FILES: Readonly<Record<string, RunStateKind>> = {
  "prd.json": "prd",
  "status.json": "status",
  "decisions.jsonl": "decisions",
};
const WORKFLOW_RUN_FILES: Readonly<Record<string, RunStateKind>> = {
  "result.json": "workflow-result",
  "ledger.md": "ledger",
};

function kindOf(tail: readonly string[]): RunStateKind | undefined {
  if (tail.length === 1) return FEATURE_FILES[tail[0] ?? ""];
  if (tail.length === 3 && tail[0] === "workflow") return WORKFLOW_RUN_FILES[tail[2] ?? ""];
  return undefined;
}

export function classifyRunStatePath(absPath: string): RunStatePath | null {
  const marker = `/${PROJECT_FEATURES_DIR}/`;
  const at = absPath.lastIndexOf(marker);
  if (at < 0) return null;
  const [feature, ...tail] = absPath.slice(at + marker.length).split("/");
  const kind = feature ? kindOf(tail) : undefined;
  if (!feature || !kind) return null;
  return { root: absPath.slice(0, at), feature, kind, rel: `${PROJECT_FEATURES_DIR}/${[feature, ...tail].join("/")}` };
}
