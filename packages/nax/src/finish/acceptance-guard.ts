/**
 * Finish B §6.3: after a review or gate fix session, before its commit. An acceptance
 * test file the session edited without a ruling naming its ACs is restored to HEAD
 * (= the pre-session content: fix sessions never commit), path only. A file absent at
 * HEAD is never deleted; it is reported as not restorable. Authorised edits stay; the AC
 * blocks that changed are reported, and any outside the ruling is flagged, not reverted.
 * Git failures are reported as `failed`, never thrown: the commit goes ahead.
 *
 * Every git listing is filtered to `paths` here, not only by pathspec: the test git stub
 * ignores pathspecs, and a guard that trusted them would restore unrelated files.
 */
import { join } from "node:path";
import { splitAcBlocks } from "./acceptance-evidence";
import type { FinishContext } from "./context";
import { gitLiteral, listBaseTree, repoRoot } from "./set-aside-git";
import type { AcceptanceGuardRecord } from "./state";
import type { Finding } from "./types";

export type GuardOutcome = AcceptanceGuardRecord;

const none = (): GuardOutcome => ({ reverted: [], notRestorable: [], changed: [], beyondRuling: [], failed: false });

export function acceptancePathsOf(context: Pick<FinishContext, "acceptanceStatus" | "groups">): string[] {
  if (context.acceptanceStatus === "disabled") return [];
  return context.groups.filter((g) => g.exists).map((g) => g.testPath);
}

/** A gate fix for a red acceptance gate must be free to repair the acceptance test (A2-R1). */
export function gateGuardPaths(
  failing: string[],
  context: Pick<FinishContext, "acceptanceStatus" | "groups">,
): string[] {
  return failing.includes("acceptance") ? [] : acceptancePathsOf(context);
}

export function allowedFrom(findings: Finding[] | undefined): { testPath: string; acIds: string[] }[] {
  return (findings ?? []).flatMap((f) => f.allowedAcceptanceEdits ?? []);
}

const nulList = (stdout: string, want: Set<string>): string[] => stdout.split("\0").filter((p) => want.has(p));

async function touchedPaths(root: string, paths: string[]): Promise<string[] | null> {
  const want = new Set(paths);
  const [diff, others] = await Promise.all([
    gitLiteral(["diff", "--name-only", "--no-renames", "-z", "HEAD", "--", ...paths], root),
    gitLiteral(["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], root),
  ]);
  if (diff.exitCode !== 0 || others.exitCode !== 0) return null;
  return [...new Set([...nulList(diff.stdout, want), ...nulList(others.stdout, want)])];
}

function changedAcs(before: string, after: string): string[] {
  const was = new Map(splitAcBlocks(before).map((b) => [b.acId, b.text]));
  const now = new Map(splitAcBlocks(after).map((b) => [b.acId, b.text]));
  return [...new Set([...was.keys(), ...now.keys()])].filter((id) => was.get(id) !== now.get(id));
}

async function acsChangedIn(root: string, path: string): Promise<string[]> {
  const head = await gitLiteral(["show", `HEAD:${path}`], root);
  const after = await _guardDeps.readText(join(root, path));
  return changedAcs(head.exitCode === 0 ? head.stdout : "", after ?? "");
}

async function restoreFromHead(root: string, paths: string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  const res = await gitLiteral(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths], root);
  return res.exitCode === 0;
}

export async function guardAcceptanceEdits(args: {
  workdir: string;
  paths: string[];
  allowed: { testPath: string; acIds: string[] }[];
}): Promise<GuardOutcome> {
  if (args.paths.length === 0) return none();
  const root = await repoRoot(args.workdir);
  const [touched, inHead] = await Promise.all([touchedPaths(root, args.paths), listBaseTree(root, "HEAD")]);
  if (touched === null || inHead === null) return { ...none(), failed: true };
  const allowedPaths = new Set(args.allowed.map((a) => a.testPath));
  const unauthorised = touched.filter((p) => !allowedPaths.has(p));
  const restorable = unauthorised.filter((p) => inHead.has(p));
  const restored = await restoreFromHead(root, restorable);
  const authorised = touched.filter((p) => allowedPaths.has(p));
  const changed = [...new Set((await Promise.all(authorised.map((p) => acsChangedIn(root, p)))).flat())];
  const ruled = new Set(args.allowed.flatMap((a) => a.acIds));
  return {
    reverted: restored ? restorable : [],
    notRestorable: unauthorised.filter((p) => !inHead.has(p)),
    changed,
    beyondRuling: changed.filter((id) => !ruled.has(id)),
    failed: !restored,
  };
}

export function guardWorthRecording(g: GuardOutcome): boolean {
  return g.failed || g.reverted.length + g.notRestorable.length + g.changed.length > 0;
}

export function mergeGuard(prev: AcceptanceGuardRecord | undefined, next: GuardOutcome): AcceptanceGuardRecord {
  const u = (a: string[] = [], b: string[] = []): string[] => [...new Set([...a, ...b])];
  return {
    reverted: u(prev?.reverted, next.reverted),
    notRestorable: u(prev?.notRestorable, next.notRestorable),
    changed: u(prev?.changed, next.changed),
    beyondRuling: u(prev?.beyondRuling, next.beyondRuling),
    failed: (prev?.failed ?? false) || next.failed,
  };
}

/** The one injectable seam: loop tests stub `guard`; `readText` is the guard's own file read. */
export const _guardDeps = {
  guard: guardAcceptanceEdits,
  readText: (path: string): Promise<string | null> =>
    Bun.file(path)
      .text()
      .catch(() => null),
};
