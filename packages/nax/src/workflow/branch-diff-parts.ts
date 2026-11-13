import { appendFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ToolCallRecord } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import { ALWAYS_EXCLUDED } from "@/review";
import { TOOL_READ_CREDIT_MAX_BYTES } from "./review-tool-reads";
import { _workflowDeps } from "./step-context";

export const DIFF_PART_MAX_BYTES = 32_000;
export const DIFF_PART_MAX_LINES = 900;
export const DIFF_PART_MAX_LINE_CHARS = 1_900;
const CONTINUATION = "\\ continued: ";

export type DiffPartText = { text: string; files: readonly string[] };
export type DiffPart = { path: string; files: readonly string[] };

/** Changed files whose every diff part was shown whole by an audited Read call. */
export function toolReadParts(calls: readonly ToolCallRecord[], parts: readonly DiffPart[]): string[] {
  const readPaths = new Set<string>();
  for (const call of calls) {
    if (
      call.tool === "Read" &&
      call.outcome === "ok" &&
      call.truncated === false &&
      call.resultBytes <= TOOL_READ_CREDIT_MAX_BYTES &&
      call.input.offset === undefined &&
      call.input.limit === undefined &&
      typeof call.input.path === "string"
    ) {
      readPaths.add(call.input.path);
    }
  }
  const holdingParts = new Map<string, string[]>();
  for (const part of parts) {
    for (const file of part.files) {
      const paths = holdingParts.get(file) ?? [];
      paths.push(part.path);
      holdingParts.set(file, paths);
    }
  }
  return [...holdingParts].filter(([, paths]) => paths.every((path) => readPaths.has(path))).map(([file]) => file);
}

export const _branchDiffPartsDeps = {
  list: (directory: string): Promise<string[]> => readdir(directory),
  remove: (path: string): Promise<void> => unlink(path),
  write: async (path: string, text: string, append: boolean): Promise<void> => {
    if (append) await appendFile(path, text);
    else await Bun.write(path, text);
  },
};
type Section = { lines: string[]; file?: string };

/** Lines retain their terminators so joining untouched sections preserves the input exactly. */
function textLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function wrapLine(line: string): string[] {
  const newline = line.endsWith("\n") ? "\n" : "";
  let remaining = newline ? line.slice(0, -1) : line;
  const result: string[] = [];
  let prefix = "";
  while (prefix.length + remaining.length > DIFF_PART_MAX_LINE_CHARS) {
    let size = DIFF_PART_MAX_LINE_CHARS - prefix.length;
    // Do not split a surrogate pair across two UTF-8 strings.
    const last = remaining.charCodeAt(size - 1);
    if (last >= 0xd800 && last <= 0xdbff) size--;
    result.push(`${prefix}${remaining.slice(0, size)}\n`);
    remaining = remaining.slice(size);
    prefix = CONTINUATION;
  }
  result.push(prefix + remaining + newline);
  return result;
}

function fileFromHeader(line: string): string | undefined {
  const prefix = "diff --git a/";
  if (!line.startsWith(prefix)) return undefined;
  const rest = line.slice(prefix.length).replace(/\n$/, "");
  const length = (rest.length - 3) / 2;
  if (!Number.isInteger(length) || length <= 0) return undefined;
  const file = rest.slice(0, length);
  return rest === `${file} b/${file}` ? file : undefined;
}

function sectionsOf(diff: string): Section[] {
  const sections: Section[] = [];
  for (const line of textLines(diff)) {
    if (line.startsWith("diff --git ") || sections.length === 0) {
      sections.push({ lines: [], file: fileFromHeader(line) });
    }
    for (const wrapped of wrapLine(line)) sections[sections.length - 1].lines.push(wrapped);
  }
  return sections;
}

function fits(lines: readonly string[]): boolean {
  return lines.length <= DIFF_PART_MAX_LINES && Buffer.byteLength(lines.join(""), "utf8") <= DIFF_PART_MAX_BYTES;
}

function part(lines: readonly string[], files: readonly string[]): DiffPartText {
  return { text: lines.join(""), files: [...new Set(files)] };
}

function impossible(): never {
  throw new NaxError("[workflow] Diff header and hunk marker exceed part limits", "WORKFLOW_REVIEW_PACKAGE_FAILED", {
    stage: "workflow",
  });
}

/** Split a section at hunk boundaries, repeating its header and, when necessary, its hunk marker. */
function splitSection(section: Section): DiffPartText[] {
  const first = section.lines.findIndex((line) => line.startsWith("@@"));
  if (first < 0) return splitHeaderOnly(section);
  const header = section.lines.slice(0, first);
  const files = section.file === undefined ? [] : [section.file];
  const result: DiffPartText[] = [];
  let current = [...header];
  let index = first;
  while (index < section.lines.length) {
    let end = index + 1;
    while (end < section.lines.length && !section.lines[end].startsWith("@@")) end++;
    const hunk = section.lines.slice(index, end);
    if (!fits([...current, ...hunk]) && current.length > header.length) {
      result.push(part(current, files));
      current = [...header];
    }
    if (fits([...current, ...hunk])) current.push(...hunk);
    else {
      const pieces = splitHunk(header, hunk, files);
      for (const piece of pieces.slice(0, -1)) result.push(piece);
      current = textLines(pieces[pieces.length - 1].text);
    }
    index = end;
  }
  if (current.length > header.length) result.push(part(current, files));
  return result;
}

function splitHunk(header: string[], hunk: string[], files: string[]): DiffPartText[] {
  const base = [...header, hunk[0]];
  if (!fits(base)) impossible();
  const result: DiffPartText[] = [];
  let current = [...base];
  for (const line of hunk.slice(1)) {
    if (!fits([...current, line])) {
      if (current.length === base.length) impossible();
      result.push(part(current, files));
      current = [...base];
      if (!fits([...current, line])) impossible();
    }
    current.push(line);
  }
  result.push(part(current, files));
  return result;
}

/** A mode-only section can itself have more header lines than fit in one part. */
function splitHeaderOnly(section: Section): DiffPartText[] {
  const files = section.file === undefined ? [] : [section.file];
  const result: DiffPartText[] = [];
  let current: string[] = [];
  for (const line of section.lines) {
    if (!fits([...current, line])) {
      if (current.length === 0) impossible();
      result.push(part(current, files));
      current = [];
    }
    current.push(line);
  }
  if (current.length) result.push(part(current, files));
  return result;
}

/** Split a git diff into bounded, ordered parts without discarding any diff content. */
export function splitDiffIntoParts(diff: string): readonly DiffPartText[] {
  const result: DiffPartText[] = [];
  let current: string[] = [];
  let files: string[] = [];
  const flush = () => {
    if (current.length) result.push(part(current, files));
    current = [];
    files = [];
  };
  for (const section of sectionsOf(diff)) {
    if (!fits(section.lines)) {
      flush();
      for (const piece of splitSection(section)) result.push(piece);
    } else {
      if (!fits([...current, ...section.lines])) flush();
      current.push(...section.lines);
      if (section.file !== undefined) files.push(section.file);
    }
  }
  flush();
  return result;
}

async function removeStaleParts(directory: string, stem: string): Promise<void> {
  const names = await _branchDiffPartsDeps.list(directory);
  for (const name of names) {
    if (name.startsWith(`${stem}-part-`) && name.endsWith(".diff")) {
      await _branchDiffPartsDeps.remove(join(directory, name));
    }
  }
}

/** Write the complete branch patch in bounded files beside the existing review package. */
export async function writeBranchDiffParts(projectDir: string, from: string, packagePath: string): Promise<DiffPart[]> {
  const path = resolve(packagePath);
  const directory = dirname(path);
  const stem = basename(path).replace(/\.diff$/, "");
  const range = `${from}..HEAD`;
  const diff = await _workflowDeps.git(
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--text",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--unified=10",
      range,
      "--",
      ".",
      ...ALWAYS_EXCLUDED,
    ],
    projectDir,
  );
  if (diff.exitCode !== 0) {
    throw new NaxError(
      `[workflow] git diff failed for ${range}: ${diff.stderr?.trim() || `exit ${diff.exitCode}`}`,
      "WORKFLOW_REVIEW_PACKAGE_FAILED",
      { stage: "workflow", from, path },
    );
  }
  const texts = splitDiffIntoParts(diff.stdout);
  try {
    await removeStaleParts(directory, stem);
    const width = texts.length > 99 ? 3 : 2;
    const parts: DiffPart[] = [];
    for (const [index, text] of texts.entries()) {
      const partPath = join(directory, `${stem}-part-${String(index + 1).padStart(width, "0")}.diff`);
      await _branchDiffPartsDeps.write(partPath, text.text, false);
      parts.push({ path: partPath, files: text.files });
    }
    const lines = parts.map((part) => `- ${part.path}: ${part.files.join(", ")}`);
    await _branchDiffPartsDeps.write(
      path,
      `\n## Diff parts (${parts.length})\n${lines.length ? `${lines.join("\n")}\n` : ""}`,
      true,
    );
    return parts;
  } catch (cause) {
    throw new NaxError(`[workflow] Failed writing diff parts for ${path}`, "WORKFLOW_REVIEW_PACKAGE_FAILED", {
      stage: "workflow",
      from,
      path,
      cause,
    });
  }
}
