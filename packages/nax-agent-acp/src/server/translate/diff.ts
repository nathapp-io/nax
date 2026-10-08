/**
 * Diffs for Edit and Write tool calls (S5 spec §4.2), built from the tool input
 * so the editor can show them at permission time, before the tool runs. Write's
 * old text is read from disk through an injected reader (the server runs locally).
 */
import { readFile, stat } from "node:fs/promises";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { inputString, resolveToolPath } from "#src/server/translate/tool-kind";

export type DiffContent = Extract<ToolCallContent, { type: "diff" }>;

export const WRITE_DIFF_OLD_MAX_BYTES = 1024 * 1024;

export type OldText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "too-large" }
  | { readonly kind: "unreadable" };

export type ReadOldText = (absolutePath: string) => Promise<OldText>;

export interface OldTextFs {
  stat(path: string): Promise<{ readonly size: number; isFile(): boolean }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

const NODE_FS: OldTextFs = { stat, readFile: (path, encoding) => readFile(path, encoding) };

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function fsReadOldText(fs: OldTextFs = NODE_FS): ReadOldText {
  return async (path) => {
    try {
      const info = await fs.stat(path);
      if (!info.isFile()) return { kind: "unreadable" };
      if (info.size > WRITE_DIFF_OLD_MAX_BYTES) return { kind: "too-large" };
      return { kind: "text", text: await fs.readFile(path, "utf8") };
    } catch (error) {
      return isMissing(error) ? { kind: "missing" } : { kind: "unreadable" };
    }
  };
}

export function editDiff(input: unknown, cwd: string): DiffContent | undefined {
  const path = inputString(input, "path");
  const oldText = inputString(input, "old_string");
  const newText = inputString(input, "new_string");
  if (path === undefined || oldText === undefined || newText === undefined) return undefined;
  return { type: "diff", path: resolveToolPath(cwd, path), oldText, newText };
}

async function writeDiff(input: unknown, cwd: string, readOld: ReadOldText): Promise<DiffContent | undefined> {
  const path = inputString(input, "path");
  const newText = inputString(input, "content");
  if (path === undefined || newText === undefined) return undefined;
  const absolute = resolveToolPath(cwd, path);
  const old = await readOld(absolute);
  switch (old.kind) {
    case "text":
      return { type: "diff", path: absolute, oldText: old.text, newText };
    case "missing":
      return { type: "diff", path: absolute, oldText: null, newText };
    case "too-large":
    case "unreadable":
      return {
        type: "diff",
        path: absolute,
        oldText: null,
        newText,
        _meta: { naxAgent: { oldTextOmitted: old.kind } },
      };
  }
}

export async function toolDiff(
  name: string,
  input: unknown,
  cwd: string,
  readOld: ReadOldText,
): Promise<DiffContent | undefined> {
  if (name === "Edit") return editDiff(input, cwd);
  if (name === "Write") return writeDiff(input, cwd, readOld);
  return undefined;
}
