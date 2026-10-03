#!/usr/bin/env bun
/** PR-first releases; tag publication is always a separately confirmed action. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { bumpVersion, distTagsFor, updateChangelog } from "./lib/release-version.ts";

const PKG = resolve(import.meta.dirname, "..");
const REPO = resolve(PKG, "../..");
const PKG_PATH = join(PKG, "package.json");
const NOTES_PATH = join(PKG, "CHANGELOG.md");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function requireCleanMain(): void {
  if (git("branch", "--show-current") !== "main") throw new Error("Must be on main to release");
  if (git("status", "--porcelain")) throw new Error("Working tree is dirty; commit or stash changes first");
}

function rejectExistingTag(tag: string): void {
  const result = execFileSync("git", ["tag", "--list", tag], { cwd: REPO, encoding: "utf8" }).trim();
  if (result) throw new Error(`Tag ${tag} already exists`);
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

function readPackage(): { version: string; [key: string]: unknown } {
  return JSON.parse(readFileSync(PKG_PATH, "utf8"));
}

async function tagRelease(dryRun: boolean): Promise<void> {
  requireCleanMain();
  const version = readPackage().version;
  const distTag = distTagsFor(version).join(" + ");
  const tag = `nax-agent-v${version}`;
  rejectExistingTag(tag);
  const action =
    version === "0.1.0"
      ? "Verify the manual 0.1.0 publish and create its GitHub prerelease"
      : `Publish through OIDC under ${distTag}`;
  console.log(`${tag}: ${action}`);
  if (dryRun) {
    console.log("Dry run; no tag created or pushed.");
    return;
  }
  if (!(await confirm(`Push ${tag}? ${action}.`))) {
    console.log("Aborted.");
    return;
  }
  git("tag", tag);
  git("push", "origin", tag);
  console.log(`Pushed ${tag}; watch https://github.com/nathapp-io/nax/actions`);
}

async function bumpRelease(kind: string, dryRun: boolean): Promise<void> {
  const pkg = readPackage();
  const current = pkg.version;
  const next = bumpVersion(current, kind);
  const originalNotes = readFileSync(NOTES_PATH, "utf8");
  const tag = `nax-agent-v${next}`;
  const branch = `release/${tag}`;
  console.log(
    `nax-agent release: ${current} -> ${next}\nTag: ${tag}\nBranch: ${branch}\nDist-tag: ${distTagsFor(next).join(" + ")}`,
  );
  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }
  const notes = updateChangelog(originalNotes, next, new Date().toISOString().slice(0, 10));
  requireCleanMain();
  rejectExistingTag(tag);
  if (!(await confirm("Prepare and push the release PR? This does not publish."))) {
    console.log("Aborted.");
    return;
  }
  git("pull", "--ff-only", "origin", "main");
  requireCleanMain();
  if (readPackage().version !== current || readFileSync(NOTES_PATH, "utf8") !== originalNotes) {
    throw new Error("Release inputs changed after pull; rerun to review the new release plan");
  }
  git("checkout", "-b", branch);
  writeFileSync(PKG_PATH, `${JSON.stringify({ ...readPackage(), version: next }, null, 2)}\n`);
  writeFileSync(NOTES_PATH, notes);
  execFileSync("bun", ["install"], { cwd: REPO, stdio: "inherit" });
  git("add", "packages/nax-agent/package.json", "packages/nax-agent/CHANGELOG.md", "bun.lock");
  const title = `chore: release ${tag}`;
  git("commit", "-m", title);
  git("push", "-u", "origin", branch);
  const temp = mkdtempSync(join(tmpdir(), "nax-agent-release-"));
  try {
    const bodyFile = join(temp, "pr-body.md");
    writeFileSync(
      bodyFile,
      `Bumps version: ${current} -> ${next}\nPublishes under: ${distTagsFor(next).join(" + ")}\n\nAfter review and merge, run from packages/nax-agent on clean main:\n\n\`\`\`sh\nbun run release tag\n\`\`\`\n\nFor 0.1.0, follow RELEASING.md's manual publish and OTP steps before pushing the tag.\n`,
    );
    execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--title",
        title,
        "--body-file",
        bodyFile,
        "--base",
        "main",
        "--head",
        branch,
        "--label",
        "skip-changelog",
      ],
      {
        cwd: REPO,
        stdio: "inherit",
      },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  git("checkout", "main");
  console.log("Review and merge the PR, then separately confirm `bun run release tag`.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const kinds = args.filter((arg) => arg !== "--dry-run");
  if (kinds.length !== 1)
    throw new Error("Usage: bun run release [--dry-run] <canary|promote|patch|minor|major|tag|X.Y.Z>");
  if (kinds[0] === "tag") await tagRelease(args.includes("--dry-run"));
  else await bumpRelease(kinds[0], args.includes("--dry-run"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
