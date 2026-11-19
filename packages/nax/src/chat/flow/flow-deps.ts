/**
 * flow-deps.ts — the one seam every flow send reaches the outside world through.
 *
 * It is a leaf on purpose. The spec-form send (`flow-provider.ts`), the steps both
 * forms share (`flow-send-steps.ts`) and the handoff send (`flow-handoff.ts`) all
 * read this same object, so one stub replaces the collaborator wherever the call is
 * made — and no value import runs back to the provider, so the split adds no cycle.
 *
 * The defaults are nax's own helpers, and `isDirty` defaults to the flow module's own
 * tree check so the pre-card and post-allow reads ask the same question — untracked
 * files count, because nothing here commits.
 */
import { commitAndPush, headSha } from "@/finish";
import { createKodaFlow } from "./flow-koda";
import { isFlowTreeDirty, readFlowOrigin, readFlowPushUrl, readFlowRepoState } from "./flow-repo";

/**
 * The seam every collaborator of a flow send goes through: the repository read, the
 * push destination, the post-allow re-check, the push and the koda create.
 */
export const _flowProviderDeps: {
  readFlowOrigin: typeof readFlowOrigin;
  readFlowRepoState: typeof readFlowRepoState;
  readFlowPushUrl: typeof readFlowPushUrl;
  headSha: (repoRoot: string) => Promise<string | null>;
  isDirty: (repoRoot: string) => Promise<boolean>;
  commitAndPush: typeof commitAndPush;
  createKodaFlow: typeof createKodaFlow;
} = {
  readFlowOrigin,
  readFlowRepoState,
  readFlowPushUrl,
  headSha,
  isDirty: isFlowTreeDirty,
  commitAndPush,
  createKodaFlow,
};
