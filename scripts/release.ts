#!/usr/bin/env bun
/**
 * release.ts — One-command release for nax (GitHub PR-first flow)
 *
 * Usage:
 *   bun run release canary          # 0.51.2 → 0.51.3-canary.1
 *   bun run release canary          # 0.51.3-canary.1 → 0.51.3-canary.2
 *   bun run release promote         # promote canary → 0.51.3 stable
 *   bun run release patch           # direct 0.51.2 → 0.51.3
 *   bun run release minor           # 0.51.2 → 0.52.0
 *   bun run release major           # 0.51.2 → 1.0.0
 *   bun run release 0.52.0          # explicit version
 *   bun run release tag             # push tag for current version (after PR merged)
 *   bun run release --dry-run patch # preview without changes
 *
 * Flow:
 *   1. bun run release <type>  → bumps version, commits, pushes branch, opens PR
 *   2. Review + merge PR       → CI runs on main
 *   3. bun run release tag     → pushes tag, triggers npm publish via OIDC
 */

import { $ } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const filteredArgs = args.filter((a) => a !== "--dry-run");
const releaseType = filteredArgs[0];

if (!releaseType) {
  console.log(`Usage: bun run release [--dry-run] <canary|promote|patch|minor|major|tag|X.Y.Z>`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "..");
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
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
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
        throw new Error(`Current version ${current} is not a canary — nothing to promote`);
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
      parseVersion(type); // validate format
      return type;
    }
  }
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

async function getCurrentBranch(): Promise<string> {
  return (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
}

// ---------------------------------------------------------------------------
// Tag command — push tag for current version
// ---------------------------------------------------------------------------

async function tagRelease() {
  const branch = await getCurrentBranch();
  if (branch !== "main") {
    console.error(`❌ Must be on main to tag. Current branch: ${branch}`);
    console.error(`   Run: git checkout main && git pull origin main`);
    process.exit(1);
  }

  const version = await readPkgVersion();
  const tagName = `v${version}`;

  // Check if tag already exists
  try {
    await $`git rev-parse ${tagName}`.quiet();
    console.error(`❌ Tag ${tagName} already exists.`);
    process.exit(1);
  } catch {
    // tag doesn't exist — good
  }

  console.log(`\n🏷️  Tagging: ${tagName}`);

  if (dryRun) {
    console.log("   (dry run — no tag created)");
    return;
  }

  const ok = await confirm(`Push tag ${tagName}? This triggers npm publish.`);
  if (!ok) {
    console.log("Aborted.");
    process.exit(0);
  }

  await $`git tag ${tagName}`;
  await $`git push origin ${tagName}`;

  const isCanary = version.includes("-canary.");
  console.log(`\n✅ Tag ${tagName} pushed — GitHub Actions will publish to npm`);
  if (isCanary) {
    console.log(`   Install: npm install -g @nathapp/nax@canary`);
    console.log(`   Promote: bun run release promote`);
  } else {
    console.log(`   Install: npm install -g @nathapp/nax@latest`);
  }
  console.log(`   Watch:   https://github.com/nathapp-io/nax/actions`);
}

// ---------------------------------------------------------------------------
// Bump command — bump version, commit, push branch, open PR
// ---------------------------------------------------------------------------

async function bumpRelease() {
  const branch = await getCurrentBranch();
  if (branch !== "main") {
    console.error(`❌ Must be on main to start a release. Current branch: ${branch}`);
    process.exit(1);
  }

  // Check working tree is clean
  const status = (await $`git status --porcelain`.text()).trim();
  if (status) {
    console.error("\n❌ Working tree is dirty. Commit or stash changes first.");
    console.error(status);
    process.exit(1);
  }

  // Pull latest
  await $`git pull origin main`.quiet();

  const currentVersion = await readPkgVersion();
  const nextVersion = bumpVersion(currentVersion, releaseType);
  const isCanary = nextVersion.includes("-canary.");
  const tagName = `v${nextVersion}`;
  const branchName = `release/${tagName}`;

  console.log(`\n📦 nax release`);
  console.log(`   Current:  ${currentVersion}`);
  console.log(`   Next:     ${nextVersion}`);
  console.log(`   Tag:      ${tagName}`);
  console.log(`   Branch:   ${branchName}`);
  console.log(`   Type:     ${isCanary ? "canary" : releaseType}`);
  if (dryRun) console.log(`   Mode:     DRY RUN`);

  if (dryRun) {
    console.log("\n🏁 Dry run complete. No changes made.");
    return;
  }

  const ok = await confirm("Proceed?");
  if (!ok) {
    console.log("Aborted.");
    process.exit(0);
  }

  // 1. Create release branch
  console.log(`\n1️⃣  Creating branch: ${branchName}`);
  await $`git checkout -b ${branchName}`;

  // 2. Bump version
  console.log(`2️⃣  Bumping package.json → ${nextVersion}`);
  await writePkgVersion(nextVersion);

  // 3. Commit
  const commitMsg = `chore: release ${tagName}`;
  console.log(`3️⃣  Committing: ${commitMsg}`);
  await $`git add package.json`.quiet();
  await $`git commit -m ${commitMsg} --no-verify`.quiet();

  // 4. Push branch
  console.log(`4️⃣  Pushing branch...`);
  await $`git push -u origin ${branchName}`;

  // 5. Open PR
  console.log(`5️⃣  Opening PR...`);
  const prTitle = isCanary ? `chore: release ${tagName} (canary)` : `chore: release ${tagName}`;
  const prBody = `## Release ${tagName}\n\nBumps version: ${currentVersion} → ${nextVersion}\n\nAfter merging, run:\n\`\`\`bash\ngit checkout main && git pull origin main\nbun run release tag\n\`\`\``;

  try {
    const prUrl = (
      await $`gh pr create --title ${prTitle} --body ${prBody} --base main --head ${branchName} --label skip-changelog`
    )
      .text()
      .then((t) => t.trim());
    console.log(`\n✅ PR created: ${await prUrl}`);
  } catch (e) {
    console.warn(`   ⚠️  Could not create PR via gh CLI. Push succeeded — create PR manually.`);
  }

  // Return to main
  await $`git checkout main`.quiet();

  console.log(`\n📋 Next steps:`);
  console.log(`   1. Review + merge PR`);
  console.log(`   2. git checkout main && git pull origin main`);
  console.log(`   3. bun run release tag`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  process.chdir(ROOT);

  if (releaseType === "tag") {
    await tagRelease();
  } else {
    await bumpRelease();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
