/**
 * `amend_body` — rewrite the PR body once the narrative node has produced prose.
 *
 * Runs *after* the PR is open and its result file written, which is the whole
 * point: acpx has no error edge, so an acp node placed before `open_pr` could
 * kill the flow and cost the PR. Here the worst case is a body missing one
 * section.
 *
 * Every failure is warned and swallowed for the same reason — a throw would
 * fail a flow whose real work already succeeded.
 */
import { gateOutputs, inputOf, loadCtxOf, narrativeOf } from "../flow-ctx";
import { detectForge } from "./forge";
import { updatePrBody } from "./pr";
import { _prBodyDeps, buildFinishBody, buildFinishTitle, loadFinishPrContext } from "./pr-body";

export async function amendPrBodyNode(ctx: {
  input: unknown;
  outputs: unknown;
}): Promise<{ route: "done"; amended: boolean }> {
  const narrative = narrativeOf(ctx);
  // Nothing to add: the body already in place is correct, and rewriting it
  // identically would spend a forge call to change nothing.
  if (!narrative) return { route: "done", amended: false };

  const i = inputOf(ctx);
  const loadCtx = loadCtxOf(ctx);
  try {
    const forge = await detectForge(_prBodyDeps.run, i.workdir, "finish-pr");
    const prCtx = await loadFinishPrContext(i, {
      base: loadCtx.base ?? "",
      gatesRan: gateOutputs(ctx).ran ?? [],
      forge,
      specPath: loadCtx.specPath,
      narrative,
    });
    await updatePrBody(forge, i.workdir, i.branch, buildFinishTitle(prCtx), buildFinishBody(prCtx));
    return { route: "done", amended: true };
  } catch (error) {
    _prBodyDeps.warn("[finish-pr] Failed to amend the PR body with the narrative", { path: i.branch, error });
    return { route: "done", amended: false };
  }
}
