/**
 * The items a finishing tool rules on that `verdict.openItems` does not list (#2578).
 *
 * - Every trusted advisor decision of the feature that is not already an open item: those nax
 *   applied without asking, and on a ready run the approved finish-approval. A decision behind a
 *   `ruling` item counts as listed. The ledger lives in the repo tree, so it is read through
 *   `readTrustedDecisions`: a line counts only when its audit artifact under `outputDir` records it.
 * - The story loops' cannot-verify lines. The verdict holds only the branch review's; a story's own
 *   lines live in the run ledgers. Each gets the id `<storyId>:cv<n>`, where `<n>` counts that story's
 *   lines from 1 in `collectLedgerItems` order (oldest run first, a repeated line once). A later run
 *   only appends, so an id keeps naming the same line; pruning a run directory renumbers.
 *
 * They never block: `buildVerdict` does not see them and `nax workflow promote` needs no ruling on
 * them. `nax workflow status` prints them, and `nax workflow record` accepts entries that name them.
 * For the same reason a source that cannot be read yields no items and a warning, never an error.
 *
 * A leaf module, imported by relative path for the reason `run-verdict.ts` gives.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { readTrustedDecisions } from "@/advisor";
import { getSafeLogger } from "@/logger";
import { collectLedgerItems, type LedgerItem } from "./ledger-items";
import { workflowFeatureDir } from "./paths";
import type { OpenItem } from "./types";

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function listedDecisionIds(openItems: readonly OpenItem[]): ReadonlySet<string> {
  return new Set(openItems.flatMap((item) => [item.id, ...(item.ruling?.decisionId ? [item.ruling.decisionId] : [])]));
}

async function advisorItems(
  dir: string,
  feature: string,
  openItems: readonly OpenItem[],
  outputDir: string,
): Promise<OpenItem[]> {
  const listed = listedDecisionIds(openItems);
  return (await readTrustedDecisions(dir, feature, outputDir))
    .filter((d) => !listed.has(d.id))
    .map((d) => ({ id: d.id, kind: "advisor", issue: oneLine(`${d.kind} ${d.action.type}: ${d.rationale}`) }));
}

function cannotVerifyItems(lines: readonly LedgerItem[]): OpenItem[] {
  const counts = new Map<string, number>();
  return lines.map((line) => {
    const n = (counts.get(line.storyId) ?? 0) + 1;
    counts.set(line.storyId, n);
    return { id: `${line.storyId}:cv${n}`, kind: "cannot-verify", issue: line.text };
  });
}

async function orNone(source: string, read: () => Promise<OpenItem[]>): Promise<OpenItem[]> {
  try {
    return await read();
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Skipping unreadable supplementary items", {
      storyId: "_run",
      source,
      error: errorMessage(err),
    });
    return [];
  }
}

/** Advisor decisions first, then cannot-verify lines; `openItems` is the run's verdict list. */
export async function loadSupplementaryItems(
  dir: string,
  feature: string,
  openItems: readonly OpenItem[],
  outputDir: string,
): Promise<OpenItem[]> {
  const advisor = await orNone("advisor ledger", () => advisorItems(dir, feature, openItems, outputDir));
  const ledger = await orNone("run ledgers", async () =>
    cannotVerifyItems((await collectLedgerItems(workflowFeatureDir(dir, feature))).cannotVerify),
  );
  return [...advisor, ...ledger];
}
