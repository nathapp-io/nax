import { join } from "node:path";
import { PROJECT_FEATURES_DIR } from "@/config";
import type { PrCheckout } from "./checkout";

/** Repo-scoped intent: only an unambiguous changed feature may supply each document. */
export function featureIntentPaths(checkout: PrCheckout): { prdPath?: string; specPath?: string } {
  const prefix = `${PROJECT_FEATURES_DIR}/`;
  const documents = checkout.changedFiles.filter((path) => {
    if (!path.startsWith(prefix)) return false;
    const parts = path.slice(prefix.length).split("/");
    return parts.length === 2 && parts[0] !== "" && parts[0] !== "." && parts[0] !== "..";
  });
  const prds = documents.filter((path) => path.endsWith("/prd.json"));
  if (prds.length > 1) return {};
  const specs = documents.filter((path) => path.endsWith("/spec.md"));
  const prd = prds[0];
  const spec = specs.length === 1 ? specs[0] : undefined;
  const sameFeature = prd === undefined || spec?.slice(0, -"spec.md".length) === prd.slice(0, -"prd.json".length);
  return {
    ...(prd !== undefined && { prdPath: join(checkout.worktree, prd) }),
    ...(spec !== undefined && sameFeature && { specPath: join(checkout.worktree, spec) }),
  };
}
