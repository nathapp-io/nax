#!/usr/bin/env bun
/**
 * generate-changelog.ts
 *
 * Extracts conventional commits between consecutive git tags and uses an LLM
 * to rewrite them as user-facing changelog entries.
 *
 * Usage:
 *   bun scripts/generate-changelog.ts                     # full run (LLM rewrite)
 *   bun scripts/generate-changelog.ts --dry-run           # extract commits only, no LLM
 *   bun scripts/generate-changelog.ts --from v0.33.0      # only tags >= v0.33.0
 *   bun scripts/generate-changelog.ts --to v0.49.6        # only tags <= v0.49.6
 *   bun scripts/generate-changelog.ts --model gemini-flash # override model
 *
 * Output: writes CHANGELOG-DRAFT.md to repo root.
 */

import { $ } from "bun";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONVENTIONAL_TYPES = ["feat", "fix", "perf", "refactor"];
const SKIP_PREFIXES = ["chore", "test", "docs", "ci", "style", "build", "release"];
const DEFAULT_MODEL = "google/gemini-3-flash-preview";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fromIdx = args.indexOf("--from");
const toIdx = args.indexOf("--to");
const modelIdx = args.indexOf("--model");

const fromTag = fromIdx >= 0 ? args[fromIdx + 1] : undefined;
const toTag = toIdx >= 0 ? args[toIdx + 1] : undefined;
const model = modelIdx >= 0 ? args[modelIdx + 1] : DEFAULT_MODEL;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface VersionEntry {
  tag: string;
  date: string;
  commits: { type: string; scope?: string; message: string; hash: string }[];
}

async function getTags(): Promise<string[]> {
  const out = await $`git tag --sort=version:refname`.text();
  return out.trim().split("\n").filter(Boolean);
}

async function getTagDate(tag: string): Promise<string> {
  const out = await $`git log -1 --format=%ai ${tag}`.text();
  return out.trim().slice(0, 10); // YYYY-MM-DD
}

async function getCommits(from: string | undefined, to: string): Promise<string[]> {
  const range = from ? `${from}..${to}` : to;
  const out = await $`git log --oneline ${range}`.text();
  return out.trim().split("\n").filter(Boolean);
}

function parseCommit(line: string): { type: string; scope?: string; message: string; hash: string } | null {
  // Format: "abc1234 type(scope): message" or "abc1234 type: message"
  const match = line.match(/^([a-f0-9]+)\s+(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
  if (!match) {
    // Non-conventional commit — try to salvage as "other"
    const simpleMatch = line.match(/^([a-f0-9]+)\s+(.+)$/);
    if (simpleMatch) {
      return { hash: simpleMatch[1], type: "other", message: simpleMatch[2] };
    }
    return null;
  }
  return {
    hash: match[1],
    type: match[2],
    scope: match[3] || undefined,
    message: match[4],
  };
}

function filterCommits(commits: ReturnType<typeof parseCommit>[]): NonNullable<ReturnType<typeof parseCommit>>[] {
  return commits.filter((c): c is NonNullable<typeof c> => {
    if (!c) return false;
    // Skip chore, test, docs, ci, etc.
    if (SKIP_PREFIXES.includes(c.type)) return false;
    // Skip merge commits
    if (c.message.startsWith("Merge branch")) return false;
    return true;
  });
}

function groupByType(
  commits: NonNullable<ReturnType<typeof parseCommit>>[],
): Record<string, NonNullable<ReturnType<typeof parseCommit>>[]> {
  const groups: Record<string, NonNullable<ReturnType<typeof parseCommit>>[]> = {};
  for (const c of commits) {
    const key = c.type;
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  return groups;
}

const TYPE_LABELS: Record<string, string> = {
  feat: "Added",
  fix: "Fixed",
  perf: "Performance",
  refactor: "Changed",
  other: "Other",
};

function formatGrouped(groups: Record<string, NonNullable<ReturnType<typeof parseCommit>>[]>): string {
  const lines: string[] = [];
  for (const type of ["feat", "fix", "perf", "refactor", "other"]) {
    const items = groups[type];
    if (!items?.length) continue;
    lines.push(`### ${TYPE_LABELS[type] || type}`);
    for (const c of items) {
      const scope = c.scope ? `**${c.scope}:** ` : "";
      lines.push(`- ${scope}${c.message}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// LLM rewrite
// ---------------------------------------------------------------------------

async function rewriteWithLLM(tag: string, rawEntries: string): Promise<string> {
  const prompt = `You are writing a public CHANGELOG for an open-source CLI tool called "nax" (AI coding agent orchestrator).

Rewrite the following raw git commit entries for version ${tag} into polished, user-facing changelog entries.

Rules:
- Keep the ### Added / ### Fixed / ### Performance grouping
- One concise line per entry (no multi-line descriptions)
- Remove internal ticket IDs (BUG-xxx, FEAT-xxx, ENH-xxx, PKG-xxx, etc.)
- Remove git hashes
- Use plain English, present tense ("Fix X" not "Fixed X")
- If a scope is present (e.g., **config:**), keep it but make it readable
- Drop trivial entries that users wouldn't care about
- If only 1-2 entries exist, keep it brief — don't pad

Raw entries:
${rawEntries}

Return ONLY the markdown content (### headers + bullet points). No preamble.`;

  try {
    const resp = await fetch("http://localhost:3001/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) {
      console.error(`  LLM error for ${tag}: ${resp.status} ${resp.statusText}`);
      return rawEntries; // fallback to raw
    }

    const json = (await resp.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message?.content?.trim() || rawEntries;
  } catch (err) {
    console.error(`  LLM call failed for ${tag}: ${err}`);
    return rawEntries; // fallback to raw
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`📋 Changelog generator — model: ${model}, dryRun: ${dryRun}`);
  if (fromTag) console.log(`  from: ${fromTag}`);
  if (toTag) console.log(`  to: ${toTag}`);

  const allTags = await getTags();
  console.log(`  Found ${allTags.length} tags total`);

  // Filter tag range
  let tags = allTags;
  let baseTag: string | undefined; // tag just before --from (for first diff)
  if (fromTag) {
    const idx = tags.indexOf(fromTag);
    if (idx < 0) {
      console.error(`Tag ${fromTag} not found`);
      process.exit(1);
    }
    baseTag = idx > 0 ? tags[idx - 1] : undefined;
    tags = tags.slice(idx);
  }
  if (toTag) {
    const idx = tags.indexOf(toTag);
    if (idx < 0) {
      console.error(`Tag ${toTag} not found`);
      process.exit(1);
    }
    tags = tags.slice(0, idx + 1);
  }

  console.log(`  Processing ${tags.length} tags: ${tags[0]} → ${tags[tags.length - 1]}\n`);

  // Extract commits for each tag pair
  const entries: VersionEntry[] = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const prevTag = i > 0 ? tags[i - 1] : baseTag; // use baseTag for first entry when --from is set
    const date = await getTagDate(tag);
    const rawCommits = await getCommits(prevTag, tag);
    const parsed = rawCommits.map(parseCommit);
    const filtered = filterCommits(parsed);

    entries.push({ tag, date, commits: filtered });
    console.log(`  ${tag} (${date}) — ${rawCommits.length} commits, ${filtered.length} kept`);
  }

  // Build changelog (newest first)
  const sections: string[] = [];
  sections.push("# Changelog\n");
  sections.push("> Auto-generated from git history. Milestone versions have hand-written highlights.\n");
  sections.push("---\n");

  for (const entry of [...entries].reverse()) {
    const version = entry.tag.replace(/^v/, "");
    sections.push(`## [${version}] — ${entry.date}\n`);

    if (entry.commits.length === 0) {
      sections.push("_No user-facing changes._\n");
      continue;
    }

    const grouped = groupByType(entry.commits);
    const raw = formatGrouped(grouped);

    if (dryRun) {
      sections.push(raw);
    } else {
      // Rate limit: 200ms between LLM calls
      await Bun.sleep(200);
      const polished = await rewriteWithLLM(entry.tag, raw);
      sections.push(polished);
    }
    sections.push(""); // blank line between versions
  }

  const output = sections.join("\n");
  const outPath = "CHANGELOG-DRAFT.md";
  await Bun.write(outPath, output);
  console.log(`\n✅ Written to ${outPath} (${output.length} bytes, ${entries.length} versions)`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
