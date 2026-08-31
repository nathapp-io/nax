#!/usr/bin/env bun

/**
 * release.ts - one-command release for nax-ai, PR-first.
 *
 * Usage:
 *   bun run release canary          0.1.0 -> 0.1.1-canary.1
 *   bun run release canary          0.1.1-canary.1 -> 0.1.1-canary.2
 *   bun run release promote         canary -> 0.1.1
 *   bun run release patch           0.1.0 -> 0.1.1
 *   bun run release minor           0.1.0 -> 0.2.0
 *   bun run release major           0.1.0 -> 1.0.0
 *   bun run release 0.2.0           explicit version
 *   bun run release tag             push the tag for the current version
 *   bun run release --dry-run patch preview without changing anything
 *
 * Flow:
 *   1. bun run release <type>  bumps the version, opens a PR
 *   2. review and merge        CI runs on main
 *   3. bun run release tag     pushes the tag, which publishes to npm
 *
 * Deliberately Node-only: no `bun` import, no `Bun.*`. This package targets
 * Node and its tsconfig is strict enough to reject bun-typed globals, so a
 * release tool that only runs under one runtime would be the first crack in
 * that stance.
 *
 * The dist-tag is NEVER chosen here. It is derived from the version by
 * .github/workflows/release.yml, so that "nothing reaches `latest` before
 * 1.0.0" is a property of the pipeline rather than something a releaser has
 * to remember. See that file for the mapping.
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rawType = args.filter((a) => a !== "--dry-run")[0];

if (rawType === undefined) {
  console.log("Usage: bun run release [--dry-run] <canary|promote|patch|minor|major|tag|X.Y.Z>");
  process.exit(1);
}

// Re-bound with an explicit type: narrowing above does not reach the function
// bodies below, which close over this rather than receiving it as an argument.
const releaseType: string = rawType;

const ROOT = join(import.meta.dirname, "..");
const PKG_PATH = join(ROOT, "package.json");

async function readPkgVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(PKG_PATH, "utf8"));
  return pkg.version;
}

async function writePkgVersion(version: string): Promise<void> {
  const pkg = JSON.parse(await readFile(PKG_PATH, "utf8"));
  pkg.version = version;
  await writeFile(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
}

function parseVersion(v: string): { major: number; minor: number; patch: number; prerelease?: string } {
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) throw new Error(`Invalid version: ${v}`);
  const prerelease = match[4];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(prerelease !== undefined ? { prerelease } : {}),
  };
}

function bumpVersion(current: string, type: string): string {
  const v = parseVersion(current);

  switch (type) {
    case "canary": {
      if (v.prerelease?.startsWith("canary.")) {
        const num = Number(v.prerelease.split(".")[1]) || 0;
        return `${v.major}.${v.minor}.${v.patch}-canary.${num + 1}`;
      }
      return `${v.major}.${v.minor}.${v.patch + 1}-canary.1`;
    }
    case "promote": {
      if (!v.prerelease?.startsWith("canary.")) {
        throw new Error(`Current version ${current} is not a canary - nothing to promote`);
      }
      return `${v.major}.${v.minor}.${v.patch}`;
    }
    case "patch":
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    case "minor":
      return `${v.major}.${v.minor + 1}.0`;
    case "major":
      return `${v.major + 1}.0.0`;
    default: {
      parseVersion(type);
      return type;
    }
  }
}

/**
 * Mirrors release.yml's mapping so the plan printed here matches what ships.
 *
 * A 0.x stable lands on both `next` and `latest`: npm points `latest` at a
 * package's first publish whatever --tag says, so "never latest before 1.0"
 * stopped being achievable at 0.1.0. Since it exists either way, it tracks the
 * current release rather than freezing on the first one.
 */
function distTagsFor(version: string): string[] {
  if (version.includes("-canary.")) return ["canary"];
  return parseVersion(version).major === 0 ? ["next", "latest"] : ["latest"];
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

/** Arguments are passed as an array, never a shell string, so a branch or tag
 *  name can never be interpreted as shell syntax. */
function git(...gitArgs: string[]): string {
  return execFileSync("git", gitArgs, { encoding: "utf8" }).trim();
}

function gitQuiet(...gitArgs: string[]): void {
  execFileSync("git", gitArgs, { stdio: "ignore" });
}

function getCurrentBranch(): string {
  return git("rev-parse", "--abbrev-ref", "HEAD");
}

async function tagRelease() {
  const branch = getCurrentBranch();
  if (branch !== "main") {
    console.error(`Must be on main to tag. Current branch: ${branch}`);
    console.error("Run: git checkout main && git pull origin main");
    process.exit(1);
  }

  const version = await readPkgVersion();
  const tagName = `v${version}`;
  const npmTags = distTagsFor(version).join(" + ");

  try {
    gitQuiet("rev-parse", tagName);
    console.error(`Tag ${tagName} already exists.`);
    process.exit(1);
  } catch {
    // No such tag, which is what we want.
  }

  console.log(`\nTagging: ${tagName}`);
  console.log(`Dist-tags it will publish under: ${npmTags}`);

  if (dryRun) {
    console.log("(dry run - no tag created)");
    return;
  }

  if (!(await confirm(`Push tag ${tagName}? This publishes to npm under "${npmTags}".`))) {
    console.log("Aborted.");
    process.exit(0);
  }

  git("tag", tagName);
  git("push", "origin", tagName);

  console.log(`\nTag ${tagName} pushed - GitHub Actions will publish to npm.`);
  console.log(`   Install: npm install @nathapp/nax-ai@${distTagsFor(version)[0]}`);
  if (npmTags === "canary") console.log("   Promote: bun run release promote");
  console.log("   Watch:   https://github.com/nathapp-io/nax-ai/actions");
}

async function bumpRelease() {
  const branch = getCurrentBranch();
  if (branch !== "main") {
    console.error(`Must be on main to start a release. Current branch: ${branch}`);
    process.exit(1);
  }

  const status = git("status", "--porcelain");
  if (status) {
    console.error("\nWorking tree is dirty. Commit or stash changes first.");
    console.error(status);
    process.exit(1);
  }

  gitQuiet("pull", "origin", "main");

  const currentVersion = await readPkgVersion();
  const nextVersion = bumpVersion(currentVersion, releaseType);
  const tagName = `v${nextVersion}`;
  const branchName = `release/${tagName}`;

  console.log("\nnax-ai release");
  console.log(`   Current:  ${currentVersion}`);
  console.log(`   Next:     ${nextVersion}`);
  console.log(`   Tag:      ${tagName}`);
  console.log(`   Branch:   ${branchName}`);
  console.log(`   Dist-tags: ${distTagsFor(nextVersion).join(" + ")}`);
  if (dryRun) {
    console.log("\nDry run complete. No changes made.");
    return;
  }

  if (!(await confirm("Proceed?"))) {
    console.log("Aborted.");
    process.exit(0);
  }

  console.log(`\n1. Creating branch: ${branchName}`);
  git("checkout", "-b", branchName);

  console.log(`2. Bumping package.json to ${nextVersion}`);
  await writePkgVersion(nextVersion);

  const commitMsg = `chore: release ${tagName}`;
  console.log(`3. Committing: ${commitMsg}`);
  gitQuiet("add", "package.json");
  gitQuiet("commit", "-m", commitMsg, "--no-verify");

  console.log("4. Pushing branch");
  git("push", "-u", "origin", branchName);

  console.log("5. Opening PR");
  const prBody = `## Release ${tagName}\n\nBumps version: ${currentVersion} -> ${nextVersion}\nPublishes under: \`${distTagsFor(nextVersion).join("` + `")}\`.\n\nAfter merging:\n\`\`\`bash\ngit checkout main && git pull origin main\nbun run release tag\n\`\`\``;

  try {
    const result = execFileSync(
      "gh",
      ["pr", "create", "--title", commitMsg, "--body", prBody, "--base", "main", "--head", branchName],
      { encoding: "utf8" },
    );
    console.log(`\nPR created: ${result.trim()}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`   gh pr create failed: ${msg}. The push succeeded - open the PR manually.`);
  }

  gitQuiet("checkout", "main");

  console.log("\nNext steps:");
  console.log("   1. Review and merge the PR");
  console.log("   2. git checkout main && git pull origin main");
  console.log("   3. bun run release tag");
}

async function main() {
  process.chdir(ROOT);
  if (releaseType === "tag") await tagRelease();
  else await bumpRelease();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
