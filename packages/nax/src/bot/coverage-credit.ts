/**
 * US-012 (branch-review-coverage): credit the files a settled `verified` ruling already covered.
 *
 * A collaborator can rule an item `verified` after reading the files it covers, at a named commit.
 * Anything that commit has not changed since needs no second read, so the bot review stops being
 * asked for it. Credit is deliberately narrow: only `verified` rulings count, only when they name
 * both a commit and the files they cover, and only for paths the review actually requires — a
 * ruling never widens or narrows the required set on its own authority.
 *
 * The git comparison is injected, and its failure (`null`) credits nothing: an unknown answer must
 * never excuse a file from review. Nothing here reads the repository.
 */
import type { BotSettledRuling } from "@/prompts";

export interface CreditInput {
  readonly settled: readonly BotSettledRuling[];
  readonly required: readonly string[];
  /** Paths changed between `sha` and HEAD, or `null` when the comparison could not be made. */
  readonly changedSince: (sha: string) => Promise<readonly string[] | null>;
}

/** The files a ruling can credit: it is `verified`, names a commit, and lists at least one path. */
function creditable(ruling: BotSettledRuling): ruling is BotSettledRuling & {
  readonly files: readonly string[];
  readonly sha: string;
} {
  return ruling.disposition === "verified" && (ruling.files?.length ?? 0) > 0 && ruling.sha !== undefined;
}

/** One git comparison per distinct sha; a ruling that credits nothing pays for none. */
function comparison(input: CreditInput): (sha: string) => Promise<readonly string[] | null> {
  const bySha = new Map<string, readonly string[] | null>();
  return async (sha) => {
    const cached = bySha.get(sha);
    if (cached !== undefined) return cached;
    const changed = await input.changedSince(sha);
    bySha.set(sha, changed);
    return changed;
  };
}

/**
 * The required paths a settled `verified` ruling has already covered, in `required` order.
 *
 * `changedSince` returning `null` credits nothing for that ruling: a comparison that failed is not
 * evidence the files are unchanged.
 */
export async function creditedFiles(input: CreditInput): Promise<string[]> {
  const required = new Set(input.required);
  const changedFor = comparison(input);
  const credited = new Set<string>();
  for (const ruling of input.settled) {
    if (!creditable(ruling)) continue;
    const changed = await changedFor(ruling.sha);
    if (changed === null) continue;
    const changedSet = new Set(changed);
    for (const file of ruling.files) if (required.has(file) && !changedSet.has(file)) credited.add(file);
  }
  return input.required.filter((path) => credited.has(path));
}
