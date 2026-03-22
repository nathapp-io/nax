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
 *   bun scripts/generate-changelog.ts --batch-size 10     # versions per LLM call (default 8)
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
const BATCH_SIZE = 8; // versions per LLM call
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fromIdx = args.indexOf("--from");
const toIdx = args.indexOf("--to");
const modelIdx = args.indexOf("--model");
const batchIdx = args.indexOf("--batch-size");

const fromTag = fromIdx >= 0 ? args[fromIdx + 1] : undefined;
const toTag = toIdx >= 0 ? args[toIdx + 1] : undefined;
const model = modelIdx >= 0 ? args[modelIdx + 1] : DEFAULT_MODEL;
const batchSize = batchIdx >= 0 ? parseInt(args[batchIdx + 1]) : BATCH_SIZE;

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
  const match = line.match(/^([a-f0-9]+)\s+(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
  if (!match) {
    const simpleMatch = line.match(/^([a-f0-9]+)\s+(.+)$/);
    if (simpleMatch) {
      return { hash: simpleMatch[1], type: "other", message: simpleMatch[2] };
    }
    return null;
  }
  return { hash: match[1], type: match[2], scope: match[3] || undefined, message: match[4] };
}

function filterCommits(commits: ReturnType<typeof parseCommit>[]): NonNullable<ReturnType<typeof parseCommit>>[] {
  return commits.filter((c): c is NonNullable<typeof c> => {
    if (!c) return false;
    if (SKIP_PREFIXES.includes(c.type)) return false;
    if (c.message.startsWith("Merge branch")) return false;
    return true;
  });
}

function groupByType(commits: NonNullable<ReturnType<typeof parseCommit>>[]): Record<string, NonNullable<ReturnType<typeof parseCommit>>[]> {
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
// LLM rewrite (batched)
// ---------------------------------------------------------------------------

interface BatchEntry {
  tag: string;
  date: string;
  raw: string;
}

/**
 * Rewrite a batch of version changelog entries with a single LLM call.
 * Returns a map of tag -> polished markdown. Falls back to raw on failure.
 */
async function rewriteBatch(batch: BatchEntry[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  if (batch.length === 0) return result;

  // Build per-version sections with a unique anchor tag
  const versionBlocks = batch.map(({ tag, date, raw }) => {
    const version = tag.replace(/^v/, "");
    return `[V_${version}] ${date}\n${raw}`;
  }).join("\n\n");

  const prompt = `You are writing a public CHANGELOG for an open-source CLI tool called "nax" (AI coding agent orchestrator).

For each version below, rewrite the raw git commit messages into polished, user-facing changelog entries.

Rules:
- Keep the ### Added / ### Fixed / ### Performance / ### Changed grouping
- One concise line per entry (no multi-line descriptions)
- Remove internal ticket IDs (BUG-xxx, FEAT-xxx, ENH-xxx, PKG-xxx, TH-xxx, etc.)
- Remove git hashes
- Use plain English, present tense ("Fix X" not "Fixed X")
- If a scope is present (e.g., **config:**), keep it but make it readable
- Drop trivial entries that users wouldn't care about
- If only 1-2 entries exist, keep it brief — don't pad

Return for EACH version block:
[V_version] YYYY-MM-DD
### Added / ### Fixed / etc.
- entry
- entry

Separate each version with a blank line. Return ALL versions listed below, even if only 1-2 entries.

Versions:
${versionBlocks}`;

  // Attempt with retries (only retry on 429 rate limit)
  let lastError = "";
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.error(`  ⏳ Retry ${attempt}/${MAX_RETRIES - 1} after ${delay}ms…`);
      await Bun.sleep(delay);
    }

    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error(`  No OPENAI_API_KEY set`);
        for (const { tag, raw } of batch) result.set(tag, raw);
        return result;
      }

      const modelName = "gpt-4o-mini"; // cheap, fast, works with OPENAI_API_KEY
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 4000,
          temperature: 0.3,
        }),
      });

      if (resp.status === 429) {
        lastError = "429 Rate limit";
        continue; // retry
      }

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`  LLM error: ${resp.status} — ${text.slice(0, 150)}`);
        for (const { tag, raw } of batch) result.set(tag, raw);
        return result;
      }

      const json = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text) {
        for (const { tag, raw } of batch) result.set(tag, raw);
        return result;
      }

      // Parse response: extract [V_version] blocks
      const versionRe = /\[V_([\d.]+)\]/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      const blocks: { version: string; content: string }[] = [];

      while ((match = versionRe.exec(text)) !== null) {
        const start = match.index;
        const version = match[1];
        // Find next [V_...] or end of string
        const nextMatch = text.slice(start + match[0].length).match(/\[V_/);
        const end = nextMatch ? start + match[0].length + (nextMatch.index ?? text.length) : text.length;
        const content = text.slice(start + match[0].length, end).trim();
        blocks.push({ version, content });
        lastIndex = end;
      }

      // Build map from version string (e.g. "0.42.0") to tag (e.g. "v0.42.0")
      for (const { tag, raw } of batch) {
        const version = tag.replace(/^v/, "");
        const block = blocks.find(b => b.version === version);
        result.set(tag, block?.content ?? raw);
      }

      return result; // success
    } catch (err) {
      lastError = String(err);
      console.error(`  LLM call failed (attempt ${attempt + 1}): ${lastError}`);
    }
  }

  // All retries exhausted — fall back to raw
  console.error(`  ⚠ All ${MAX_RETRIES} attempts failed (${lastError}). Using raw entries.`);
  for (const { tag, raw } of batch) result.set(tag, raw);
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`📋 Changelog generator — model: ${model}, batchSize: ${batchSize}, dryRun: ${dryRun}`);
  if (fromTag) console.log(`  from: ${fromTag}`);
  if (toTag) console.log(`  to: ${toTag}`);

  const allTags = await getTags();
  console.log(`  Found ${allTags.length} tags total\n`);

  // Filter tag range
  let tags = allTags;
  let baseTag: string | undefined;
  if (fromTag) {
    const idx = tags.indexOf(fromTag);
    if (idx < 0) { console.error(`Tag ${fromTag} not found`); process.exit(1); }
    baseTag = idx > 0 ? tags[idx - 1] : undefined;
    tags = tags.slice(idx);
  }
  if (toTag) {
    const idx = tags.indexOf(toTag);
    if (idx < 0) { console.error(`Tag ${toTag} not found`); process.exit(1); }
    tags = tags.slice(0, idx + 1);
  }

  console.log(`  Processing ${tags.length} tags: ${tags[0]} → ${tags[tags.length - 1]}\n`);

  // Extract commits for each tag pair
  const entries: VersionEntry[] = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const prevTag = i > 0 ? tags[i - 1] : baseTag;
    const date = await getTagDate(tag);
    const rawCommits = await getCommits(prevTag, tag);
    const parsed = rawCommits.map(parseCommit);
    const filtered = filterCommits(parsed);
    entries.push({ tag, date, commits: filtered });
    console.log(`  ${tag} (${date}) — ${rawCommits.length} commits, ${filtered.length} kept`);
  }

  // Build changelog (newest first)
  const changelogByTag = new Map<string, string>();

  if (dryRun) {
    for (const entry of entries) {
      if (entry.commits.length === 0) { changelogByTag.set(entry.tag, "_No user-facing changes._"); continue; }
      const grouped = groupByType(entry.commits);
      changelogByTag.set(entry.tag, formatGrouped(grouped));
    }
  } else {
    // Batch entries and call LLM per batch
    for (let i = 0; i < entries.length; i += batchSize) {
      const batchEntries = entries.slice(i, i + batchSize);
      const batch: BatchEntry[] = [];

      for (const entry of batchEntries) {
        if (entry.commits.length === 0) {
          changelogByTag.set(entry.tag, "_No user-facing changes._");
          continue;
        }
        const grouped = groupByType(entry.commits);
        const raw = formatGrouped(grouped);
        batch.push({ tag: entry.tag, date: entry.date, raw });
      }

      if (batch.length > 0) {
        console.error(`\n  📦 Batch ${Math.floor(i / batchSize) + 1}: ${batch.map(b => b.tag).join(", ")}`);
        await Bun.sleep(300); // inter-batch delay
        const polished = await rewriteBatch(batch);
        for (const [tag, content] of polished) {
          changelogByTag.set(tag, content);
        }
      }
    }
  }

  // Assemble final changelog
  const sections: string[] = [];
  sections.push("# Changelog\n");
  sections.push("> Auto-generated from git history. Milestone versions have hand-written highlights.\n");
  sections.push("---\n");

  for (const entry of [...entries].reverse()) {
    const version = entry.tag.replace(/^v/, "");
    const content = changelogByTag.get(entry.tag) ?? "_No user-facing changes._";
    sections.push(`## [${version}] — ${entry.date}\n`);
    sections.push(content);
    sections.push("");
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
