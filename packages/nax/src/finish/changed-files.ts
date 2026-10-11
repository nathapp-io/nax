/** A4: files the feature branch changed, for the review prompts and coverage telemetry. */
import { _finishGitDeps } from "./commit";

export async function changedFiles(workdir: string, base: string): Promise<string[]> {
  try {
    const res = await _finishGitDeps.git(["diff", "--name-only", `${base}...HEAD`], workdir);
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return []; // git unavailable: the prompts fall back to "read the diff yourself"
  }
}
