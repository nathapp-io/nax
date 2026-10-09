#!/usr/bin/env bun
/**
 * release.ts - one release for every published nax package (lockstep versioning).
 *
 * From the repo root:
 *   bun run release [--dry-run] <canary|promote|patch|minor|major|X.Y.Z>
 *     Bumps nax-ai, nax-agent, nax-agent-acp and nax to one version, pins
 *     @nathapp/nax-ai to it, dates the changelogs, refreshes bun.lock, opens a PR.
 *   bun run release [--dry-run] tag
 *     On clean main, pushes vX.Y.Z; .github/workflows/release.yml then publishes
 *     all four packages in dependency order.
 *
 * PR-first: pushing the tag is always a separately confirmed action. See RELEASING.md.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  CHANGELOG_PACKAGES,
  LOCKSTEP_PACKAGES,
  lockstepErrors,
  type Manifests,
  readManifests,
  withVersion,
  writeManifests,
} from "#scripts/lib/lockstep";
import { distTagsFor, nextSharedVersion, stampChangelog } from "#scripts/lib/release-version";

const REPO = resolve(import.meta.dir, "../../..");
const NAMES = LOCKSTEP_PACKAGES.map((p) => p.name).join(", ");

interface ReleasePlan {
  readonly current: string;
  readonly next: string;
  readonly tag: string;
  readonly branch: string;
  readonly manifests: Manifests;
  readonly changelogs: ReadonlyMap<string, string>;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function requireCleanMain(): void {
  if (git("branch", "--show-current") !== "main") throw new Error("Must be on main to release");
  if (git("status", "--porcelain")) throw new Error("Working tree is dirty; commit or stash changes first");
}

function rejectExistingTag(tag: string): void {
  if (git("tag", "--list", tag)) throw new Error(`Tag ${tag} already exists`);
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.once("close", () => resolveAnswer(false));
    rl.question(`${message} [y/N] `, (answer) => {
      resolveAnswer(answer.trim().toLowerCase() === "y");
      rl.close();
    });
  });
}

/** The current shared version; refuses a workspace that is out of lockstep. */
function sharedVersion(manifests: Manifests): string {
  const errors = lockstepErrors(manifests);
  if (errors.length > 0) throw new Error(`Packages are not in lockstep:\n${errors.join("\n")}`);
  return manifests.get(LOCKSTEP_PACKAGES[0]?.dir ?? "")?.version ?? "";
}

function readChangelogs(): ReadonlyMap<string, string> {
  return new Map(CHANGELOG_PACKAGES.map((dir) => [dir, readFileSync(join(REPO, dir, "CHANGELOG.md"), "utf8")]));
}

function snapshot(manifests: Manifests, changelogs: ReadonlyMap<string, string>): string {
  return JSON.stringify([[...manifests], [...changelogs]]);
}

function planRelease(kind: string): ReleasePlan {
  const manifests = readManifests(REPO);
  const current = sharedVersion(manifests);
  const next = nextSharedVersion(current, kind);
  return { current, next, tag: `v${next}`, branch: `release/v${next}`, manifests, changelogs: readChangelogs() };
}

function describePlan(plan: ReleasePlan): void {
  console.log(
    [
      `nax packages: ${plan.current} -> ${plan.next}`,
      `Packages: ${NAMES}`,
      `Tag: ${plan.tag}`,
      `Branch: ${plan.branch}`,
      `Dist-tag: ${distTagsFor(plan.next).join(" + ")}`,
    ].join("\n"),
  );
}

function writeRelease(plan: ReleasePlan, notes: ReadonlyMap<string, string>): void {
  writeManifests(REPO, withVersion(plan.manifests, plan.next));
  for (const [dir, text] of notes) writeFileSync(join(REPO, dir, "CHANGELOG.md"), text);
  execFileSync("bun", ["install"], { cwd: REPO, stdio: "inherit" });
  git(
    "add",
    "bun.lock",
    ...LOCKSTEP_PACKAGES.map((p) => `${p.dir}/package.json`),
    ...CHANGELOG_PACKAGES.map((dir) => `${dir}/CHANGELOG.md`),
  );
  git("commit", "-m", `chore: release ${plan.tag}`);
}

function openPullRequest(plan: ReleasePlan): void {
  const temp = mkdtempSync(join(tmpdir(), "nax-release-"));
  try {
    const bodyFile = join(temp, "pr-body.md");
    writeFileSync(
      bodyFile,
      `Bumps every published nax package: ${plan.current} -> ${plan.next}\n${LOCKSTEP_PACKAGES.map((p) => `- ${p.name}`).join("\n")}\nPublishes under: ${distTagsFor(plan.next).join(" + ")}\n\nAfter review and merge, run from the repo root on clean main:\n\n\`\`\`sh\nbun run release tag\n\`\`\`\n`,
    );
    execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--title",
        `chore: release ${plan.tag}`,
        "--body-file",
        bodyFile,
        "--base",
        "main",
        "--head",
        plan.branch,
        "--label",
        "skip-changelog",
      ],
      { cwd: REPO, stdio: "inherit" },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function bumpRelease(kind: string, dryRun: boolean): Promise<void> {
  const plan = planRelease(kind);
  describePlan(plan);
  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const notes = new Map([...plan.changelogs].map(([dir, text]) => [dir, stampChangelog(text, plan.next, today)]));
  requireCleanMain();
  rejectExistingTag(plan.tag);
  if (!(await confirm("Prepare and push the release PR? This does not publish."))) {
    console.log("Aborted.");
    return;
  }
  git("pull", "--ff-only", "origin", "main");
  requireCleanMain();
  if (snapshot(readManifests(REPO), readChangelogs()) !== snapshot(plan.manifests, plan.changelogs)) {
    throw new Error("Release inputs changed after pull; rerun to review the new release plan");
  }
  git("checkout", "-b", plan.branch);
  writeRelease(plan, notes);
  git("push", "-u", "origin", plan.branch);
  openPullRequest(plan);
  git("checkout", "main");
  console.log("Review and merge the PR, then separately confirm `bun run release tag` on clean main.");
}

async function tagRelease(dryRun: boolean): Promise<void> {
  requireCleanMain();
  const version = sharedVersion(readManifests(REPO));
  const tag = `v${version}`;
  rejectExistingTag(tag);
  console.log(`${tag}: publishes ${NAMES} at ${version} under ${distTagsFor(version).join(" + ")}`);
  if (dryRun) {
    console.log("Dry run; no tag created or pushed.");
    return;
  }
  if (!(await confirm(`Push ${tag}? This publishes all four packages to npm.`))) {
    console.log("Aborted.");
    return;
  }
  git("tag", tag);
  git("push", "origin", tag);
  console.log(`Pushed ${tag}; watch https://github.com/nathapp-io/nax/actions`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const kinds = args.filter((arg) => arg !== "--dry-run");
  if (kinds.length !== 1) {
    throw new Error("Usage: bun run release [--dry-run] <canary|promote|patch|minor|major|tag|X.Y.Z>");
  }
  if (kinds[0] === "tag") await tagRelease(dryRun);
  else await bumpRelease(kinds[0] ?? "", dryRun);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
