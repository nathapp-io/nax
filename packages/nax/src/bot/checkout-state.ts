import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";

const WORKFLOWS_DIR = ".github/workflows";
const GITLAB_CI = ".gitlab-ci.yml";

export const _checkoutStateDeps = {
  readWorkflowFiles: async (path: string): Promise<string[]> =>
    (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name),
  exists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  getLogger: getSafeLogger,
};

/** Repo-scoped discovery; all returned paths are relative to the supplied checkout. */
export async function listCiConfigFiles(worktree: string): Promise<string[]> {
  try {
    const names = await _checkoutStateDeps.readWorkflowFiles(join(worktree, WORKFLOWS_DIR)).catch((cause: unknown) => {
      // A missing workflow directory is normal, and does not preclude GitLab CI.
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return [];
      throw cause;
    });
    const paths = names
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name) => `${WORKFLOWS_DIR}/${name}`);
    if (await _checkoutStateDeps.exists(join(worktree, GITLAB_CI))) paths.push(GITLAB_CI);
    return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (cause) {
    _checkoutStateDeps.getLogger()?.warn("bot", "Failed to list CI configuration files", {
      worktree,
      error: errorMessage(cause),
    });
    return [];
  }
}
