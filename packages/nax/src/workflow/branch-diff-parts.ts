import { NaxError } from "@/errors";

export const DIFF_PART_MAX_BYTES = 32_000;
export const DIFF_PART_MAX_LINES = 900;
export const DIFF_PART_MAX_LINE_CHARS = 1_900;
const CONTINUATION = "\\ continued: ";

export type DiffPartText = { text: string; files: readonly string[] };
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
