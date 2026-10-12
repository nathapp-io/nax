/** The branch's seed (spec §7 step 2, P4-R15): where the feature branch left the default branch. */
import type { PRD } from "@/prd";
import { _workflowDeps } from "./step-context";

const ORIGIN_HEAD = "refs/remotes/origin/HEAD";
const ORIGIN_PREFIX = "refs/remotes/origin/";
const FALLBACK_BRANCH = "main";

async function originDefaultRef(projectDir: string): Promise<string | null> {
  const { stdout, exitCode } = await _workflowDeps.git(["symbolic-ref", ORIGIN_HEAD], projectDir);
  const ref = stdout.trim();
  return exitCode === 0 && ref.startsWith(ORIGIN_PREFIX) ? ref : null;
}

async function mergeBase(projectDir: string, ref: string): Promise<string | null> {
  const { stdout, exitCode } = await _workflowDeps.git(["merge-base", ref, "HEAD"], projectDir);
  const sha = stdout.trim();
  return exitCode === 0 && sha !== "" ? sha : null;
}

export async function resolveSeed(projectDir: string, prd: PRD): Promise<string | null> {
  const origin = await originDefaultRef(projectDir);
  const fromOrigin = origin ? await mergeBase(projectDir, origin) : null;
  if (fromOrigin) return fromOrigin;
  const fromMain = await mergeBase(projectDir, FALLBACK_BRANCH);
  if (fromMain) return fromMain;
  return prd.userStories.find((s) => s.storyGitRef)?.storyGitRef ?? null;
}
