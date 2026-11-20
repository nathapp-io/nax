/** Reconcile the exact head's durable carry into every consumer of the fix review, including saves. */
import { type FindingTrigger, isBlockingFinding } from "@/workflow/blocking-findings";
import { carriedRecordComment, parseCarriedRecord } from "./carried-record";
import type { BotFixEnv } from "./fix-steps";
import type { AgreedItem } from "./post";
import { reviewBlockingTriggers } from "./review-blocking";
import { readConfirmedKeys, readSettledKeys } from "./rulings";

export const _fixCarriedDeps = { readSettledKeys, readConfirmedKeys };

function candidates(env: BotFixEnv, blocking: readonly FindingTrigger[]): AgreedItem[] {
  const head = env.info.headSha;
  if (env.review.headSha !== head) return [];
  const own = carriedRecordComment(env.own, head);
  const record = own === undefined ? null : parseCarriedRecord(own.comment.body);
  if (record?.headSha !== head) return [];
  const seen = new Set(env.review.agreed.map(({ key }) => key));
  return record.findings.flatMap((entry): AgreedItem[] => {
    if (seen.has(entry.key) || !isBlockingFinding(entry, blocking)) return [];
    seen.add(entry.key);
    return [{ kind: "finding", ...entry }];
  });
}

/** An incomplete rerun may omit a blocker from its artifact while the PR still preserves it. */
export async function withCarriedFixFindings(env: BotFixEnv): Promise<BotFixEnv> {
  const carry = candidates(env, reviewBlockingTriggers(env));
  if (carry.length === 0) return env;
  const input = {
    ref: env.ref,
    login: env.user.login,
    threads: env.threads,
    comments: env.own.filter(({ threadId }) => threadId === undefined).map(({ comment }) => comment),
    deps: env.forge,
    cwd: env.repoRoot,
  };
  const withdrawn = new Set(
    (env.review.events ?? []).flatMap((event) => (event.type === "finding-withdrawn" ? [event.key] : [])),
  );
  // An unreadable ruling aborts preparation rather than sending potentially settled work to a fixer.
  const [settled, confirmed] = await Promise.all([
    _fixCarriedDeps.readSettledKeys(input),
    withdrawn.size === 0 ? new Set<string>() : _fixCarriedDeps.readConfirmedKeys(input),
  ]);
  const open = carry.filter(({ key }) => (withdrawn.has(key) ? confirmed.has(key) : !settled.has(key)));
  return { ...env, review: { ...env.review, agreed: [...env.review.agreed, ...open] } };
}
