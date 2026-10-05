#!/usr/bin/env bun
/** PR-first releases; tag publication is always a separately confirmed action. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { bumpVersion, compareVersions, distTagsFor, updateChangelog } from "./lib/release-version.ts";

const PKG = resolve(import.meta.dirname, "..");
const REPO = resolve(PKG, "../..");
const PKG_PATH = join(PKG, "package.json");
const NOTES_PATH = join(PKG, "CHANGELOG.md");
const ACP = resolve(PKG, "../nax-agent-acp");
const ACP_PKG_PATH = join(ACP, "package.json");
const ACP_NOTES_PATH = join(ACP, "CHANGELOG.md");
const ACP_BOOTSTRAP = "0.3.0";

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

function readJsonAt(path: string): { version: string; [key: string]: unknown } {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** R10: nax-agent and nax-agent-acp always share one version. */
function lockstepVersion(): string {
  const agent = readPackage().version;
  const acp = readJsonAt(ACP_PKG_PATH).version;
  if (agent !== acp)
    throw new Error(`nax-agent ${agent} and nax-agent-acp ${acp} must share one version (R10 lockstep)`);
  return agent;
}

/** True only when npm reports the exact `name@version`; any registry failure counts as not published. */
function onNpm(spec: string): boolean {
  try {
    const out = execFileSync("npm", ["view", spec, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return out.trim() !== "";
  } catch {
    // Any registry failure counts as "not proven published"; the caller refuses.
    return false;
  }
}

async function tagAcpRelease(dryRun: boolean): Promise<void> {
  requireCleanMain();
  const version = lockstepVersion();
  const tag = `nax-agent-acp-v${version}`;
  rejectExistingTag(tag);
  const action =
    version === ACP_BOOTSTRAP
      ? `Verify the manual ${ACP_BOOTSTRAP} publish and create its GitHub prerelease`
      : `Publish through OIDC under ${distTagsFor(version).join(" + ")}`;
  console.log(`${tag}: ${action}`);
  if (dryRun) {
    console.log("Dry run; no tag created or pushed.");
    return;
  }
  if (!onNpm(`@nathapp/nax-agent@${version}`)) {
    throw new Error(`@nathapp/nax-agent@${version} is not on npm; release nax-agent first (release order)`);
  }
  if (version === ACP_BOOTSTRAP && !onNpm(`@nathapp/nax-agent-acp@${ACP_BOOTSTRAP}`)) {
    throw new Error(`@nathapp/nax-agent-acp@${ACP_BOOTSTRAP} must be published manually first (RELEASING.md)`);
  }
  if (!(await confirm(`Push ${tag}? ${action}.`))) {
    console.log("Aborted.");
    return;
  }
  git("tag", tag);
  git("push", "origin", tag);
  console.log(`Pushed ${tag}; watch https://github.com/nathapp-io/nax/actions`);
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
  const acpCurrent = readJsonAt(ACP_PKG_PATH).version;
  const originalAcpNotes = readFileSync(ACP_NOTES_PATH, "utf8");
  const tag = `nax-agent-v${next}`;
  const branch = `release/${tag}`;
  const withAcp = compareVersions(next, acpCurrent) >= 0;
  const tags = withAcp
    ? `Tags: ${tag}, nax-agent-acp-v${next}`
    : `nax-agent-acp stays at ${acpCurrent} (ahead of nax-agent)`;
  console.log(
    `nax-agent release: ${current} -> ${next}\nTag: ${tag}\nBranch: ${branch}\nDist-tag: ${distTagsFor(next).join(" + ")}\n${tags}`,
  );
  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const notes = updateChangelog(originalNotes, next, today);
  let acpNotes: string | undefined;
  if (withAcp) {
    try {
      acpNotes = updateChangelog(originalAcpNotes, next, today);
    } catch (error) {
      throw new Error(`nax-agent-acp: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  requireCleanMain();
  rejectExistingTag(tag);
  if (!(await confirm("Prepare and push the release PR? This does not publish."))) {
    console.log("Aborted.");
    return;
  }
  git("pull", "--ff-only", "origin", "main");
  requireCleanMain();
  if (
    readPackage().version !== current ||
    readFileSync(NOTES_PATH, "utf8") !== originalNotes ||
    readJsonAt(ACP_PKG_PATH).version !== acpCurrent ||
    readFileSync(ACP_NOTES_PATH, "utf8") !== originalAcpNotes
  ) {
    throw new Error("Release inputs changed after pull; rerun to review the new release plan");
  }
  git("checkout", "-b", branch);
  writeFileSync(PKG_PATH, `${JSON.stringify({ ...readPackage(), version: next }, null, 2)}\n`);
  writeFileSync(NOTES_PATH, notes);
  if (withAcp && acpNotes !== undefined) {
    writeFileSync(ACP_PKG_PATH, `${JSON.stringify({ ...readJsonAt(ACP_PKG_PATH), version: next }, null, 2)}\n`);
    writeFileSync(ACP_NOTES_PATH, acpNotes);
  }
  execFileSync("bun", ["install"], { cwd: REPO, stdio: "inherit" });
  git(
    "add",
    "packages/nax-agent/package.json",
    "packages/nax-agent/CHANGELOG.md",
    "bun.lock",
    ...(withAcp ? (["packages/nax-agent-acp/package.json", "packages/nax-agent-acp/CHANGELOG.md"] as const) : []),
  );
  const title = `chore: release ${tag}`;
  git("commit", "-m", title);
  git("push", "-u", "origin", branch);
  const temp = mkdtempSync(join(tmpdir(), "nax-agent-release-"));
  try {
    const bodyFile = join(temp, "pr-body.md");
    const acpLine = withAcp
      ? `Also bumps @nathapp/nax-agent-acp to ${next} (R10 lockstep). After nax-agent-v${next} is published, run \`bun run release tag-acp\`.\n`
      : "";
    writeFileSync(
      bodyFile,
      `Bumps version: ${current} -> ${next}\nPublishes under: ${distTagsFor(next).join(" + ")}\n${acpLine}\nAfter review and merge, run from packages/nax-agent on clean main:\n\n\`\`\`sh\nbun run release tag\n\`\`\`\n\nFor 0.1.0, follow RELEASING.md's manual publish and OTP steps before pushing the tag.\n`,
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
    throw new Error("Usage: bun run release [--dry-run] <canary|promote|patch|minor|major|tag|tag-acp|X.Y.Z>");
  if (kinds[0] === "tag") await tagRelease(args.includes("--dry-run"));
  else if (kinds[0] === "tag-acp") await tagAcpRelease(args.includes("--dry-run"));
  else await bumpRelease(kinds[0], args.includes("--dry-run"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
