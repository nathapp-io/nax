#!/usr/bin/env bun
/**
 * release.ts — One-command release for nax
 *
 * Usage:
 *   bun run release canary          # 0.50.1 → 0.50.2-canary.1
 *   bun run release canary          # 0.50.2-canary.1 → 0.50.2-canary.2
 *   bun run release promote         # promote canary → 0.50.2 stable
 *   bun run release patch           # direct 0.50.1 → 0.50.2
 *   bun run release minor           # 0.50.1 → 0.51.0
 *   bun run release major           # 0.50.1 → 1.0.0
 *   bun run release 0.52.0          # explicit version
 *   bun run release --dry-run patch # preview without committing
 */

import { $ } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LLM_ENDPOINT = "http://localhost:3001/v1/chat/completions";
const LLM_MODEL = "google/gemini-3-flash-preview";
const CONVENTIONAL_KEEP = ["feat", "fix", "perf", "refactor"];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const filteredArgs = args.filter((a) => a !== "--dry-run");
const releaseType = filteredArgs[0];

if (!releaseType) {
  console.log(`Usage: bun run release [--dry-run] <canary|promote|patch|minor|major|X.Y.Z>`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const CHANGELOG_PATH = join(ROOT, "CHANGELOG.md");

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
        // Increment canary number: 0.50.2-canary.1 → 0.50.2-canary.2
        const num = Number(v.prerelease.split(".")[1]) || 0;
        return `${v.major}.${v.minor}.${v.patch}-canary.${num + 1}`;
      }
      // New canary: 0.50.1 → 0.50.2-canary.1
      return `${v.major}.${v.minor}.${v.patch + 1}-canary.1`;
    }
    case "promote": {
      if (!v.prerelease?.startsWith("canary.")) {
        throw new Error(`Current version ${current} is not a canary — nothing to promote`);
      }
      // Strip prerelease: 0.50.2-canary.3 → 0.50.2
      return `${v.major}.${v.minor}.${v.patch}`;
    }
    case "patch":
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    case "minor":
      return `${v.major}.${v.minor + 1}.0`;
    case "major":
      return `${v.major + 1}.0.0`;
    default: {
      // Explicit version — validate format
      parseVersion(type);
      return type;
    }
  }
}

async function getLastTag(): Promise<string | null> {
  try {
    const out = await $`git describe --tags --abbrev=0`.text();
    return out.trim() || null;
  } catch {
    return null;
  }
}

async function getCommitsSinceTag(tag: string | null): Promise<string[]> {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const out = await $`git log --oneline ${range}`.text();
  return out.trim().split("\n").filter(Boolean);
}

function filterConventional(lines: string[]): { type: string; scope?: string; message: string }[] {
  const results: { type: string; scope?: string; message: string }[] = [];
  for (const line of lines) {
    const match = line.match(/^[a-f0-9]+\s+(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
    if (!match) continue;
    const [, type, scope, message] = match;
    if (!CONVENTIONAL_KEEP.includes(type)) continue;
    if (message.startsWith("Merge branch")) continue;
    results.push({ type, scope: scope || undefined, message });
  }
  return results;
}

const TYPE_LABELS: Record<string, string> = {
  feat: "Added",
  fix: "Fixed",
  perf: "Performance",
  refactor: "Changed",
};

function formatRawNotes(commits: ReturnType<typeof filterConventional>): string {
  const groups: Record<string, typeof commits> = {};
  for (const c of commits) {
    const key = c.type;
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }

  const lines: string[] = [];
  for (const type of ["feat", "fix", "perf", "refactor"]) {
    const items = groups[type];
    if (!items?.length) continue;
    lines.push(`### ${TYPE_LABELS[type]}`);
    for (const c of items) {
      const scope = c.scope ? `**${c.scope}:** ` : "";
      lines.push(`- ${scope}${c.message}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function polishWithLLM(version: string, raw: string): Promise<string> {
  const prompt = `Rewrite these raw git commit entries for nax v${version} into polished, user-facing changelog entries.

Rules:
- Keep ### Added / ### Fixed / ### Performance grouping
- One concise line per entry, present tense
- Remove internal ticket IDs (BUG-xxx, FEAT-xxx, ENH-xxx, etc.)
- Drop trivial entries users wouldn't care about
- If few entries, keep it brief

Raw:
${raw}

Return ONLY markdown (### headers + bullets). No preamble.`;

  try {
    const resp = await fetch(LLM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) {
      console.warn(`  ⚠️  LLM returned ${resp.status} — using raw notes`);
      return raw;
    }

    const json = (await resp.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message?.content?.trim() || raw;
  } catch {
    console.warn("  ⚠️  LLM unavailable — using raw notes");
    return raw;
  }
}

async function prependChangelog(version: string, date: string, notes: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(CHANGELOG_PATH, "utf8");
  } catch {
    existing = "# Changelog\n";
  }

  const entry = `## [${version}] — ${date}\n\n${notes}\n\n`;

  // Insert after the # Changelog header (and any preamble)
  const headerEnd = existing.indexOf("\n---");
  if (headerEnd >= 0) {
    const before = existing.slice(0, headerEnd + 4);
    const after = existing.slice(headerEnd + 4);
    await writeFile(CHANGELOG_PATH, `${before}\n\n${entry}${after}`);
  } else {
    // No --- separator — insert after first line
    const firstNewline = existing.indexOf("\n");
    if (firstNewline >= 0) {
      const before = existing.slice(0, firstNewline + 1);
      const after = existing.slice(firstNewline + 1);
      await writeFile(CHANGELOG_PATH, `${before}\n${entry}${after}`);
    } else {
      await writeFile(CHANGELOG_PATH, `${existing}\n\n${entry}`);
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  process.chdir(ROOT);

  const currentVersion = await readPkgVersion();
  const nextVersion = bumpVersion(currentVersion, releaseType);
  const isCanary = nextVersion.includes("-canary.");
  const isPromote = releaseType === "promote";
  const tagName = `v${nextVersion}`;

  console.log(`\n📦 nax release`);
  console.log(`   Current:  ${currentVersion}`);
  console.log(`   Next:     ${nextVersion}`);
  console.log(`   Tag:      ${tagName}`);
  console.log(`   Type:     ${isCanary ? "canary" : isPromote ? "promote" : "stable"}`);
  if (dryRun) console.log(`   Mode:     DRY RUN`);

  // Check working tree is clean
  const status = (await $`git status --porcelain`.text()).trim();
  if (status) {
    console.error("\n❌ Working tree is dirty. Commit or stash changes first.");
    console.error(status);
    process.exit(1);
  }

  // Generate release notes
  console.log("\n📝 Generating release notes...");
  const lastTag = await getLastTag();
  console.log(`   Last tag: ${lastTag || "(none)"}`);
  const rawCommits = await getCommitsSinceTag(lastTag);
  const filtered = filterConventional(rawCommits);
  console.log(`   Commits:  ${rawCommits.length} total, ${filtered.length} user-facing`);

  let notes: string;
  if (filtered.length === 0) {
    notes = "_No user-facing changes._";
  } else {
    const raw = formatRawNotes(filtered);
    notes = await polishWithLLM(nextVersion, raw);
  }

  // Preview
  console.log("\n--- Release Notes Preview ---");
  console.log(notes);
  console.log("--- End Preview ---\n");

  if (dryRun) {
    console.log("🏁 Dry run complete. No changes made.");
    return;
  }

  // Confirm
  const ok = await confirm("Proceed with release?");
  if (!ok) {
    console.log("Aborted.");
    process.exit(0);
  }

  // 1. Bump version in package.json
  console.log(`\n1️⃣  Bumping package.json → ${nextVersion}`);
  await writePkgVersion(nextVersion);

  // 2. Update CHANGELOG (skip for canary)
  if (!isCanary) {
    console.log("2️⃣  Updating CHANGELOG.md");
    await prependChangelog(nextVersion, today(), notes);
  } else {
    console.log("2️⃣  Skipping CHANGELOG (canary)");
  }

  // 3. Commit
  const commitMsg = isCanary
    ? `chore: release ${tagName} (canary)`
    : `chore: release ${tagName}`;
  console.log(`3️⃣  Committing: ${commitMsg}`);
  await $`git add package.json CHANGELOG.md`.quiet();
  await $`git commit -m ${commitMsg}`.quiet();

  // 4. Tag
  console.log(`4️⃣  Tagging: ${tagName}`);
  await $`git tag ${tagName}`.quiet();

  // 5. Push
  console.log("5️⃣  Pushing commit + tag...");
  // Detect remote name (github preferred, then origin)
  let remote = "origin";
  try {
    const remotes = (await $`git remote`.text()).trim().split("\n");
    if (remotes.includes("github")) remote = "github";
  } catch {
    // keep origin
  }

  const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
  await $`git push ${remote} ${branch}`;
  await $`git push ${remote} ${tagName}`;

  console.log(`\n✅ Released ${tagName}`);
  if (isCanary) {
    console.log(`   Install:  npm install -g @nathapp/nax@canary`);
    console.log(`   Promote:  bun run release promote`);
  } else {
    console.log(`   Install:  npm install -g @nathapp/nax`);
  }
  console.log(`   GitHub Actions will handle: test → npm publish → GitHub Release`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
