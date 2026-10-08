/**
 * Diffs for Edit and Write tool calls (S5 spec §4.2), built from the tool input
 * so the editor can show them at permission time, before the tool runs. Write's
 * old text is read from disk through an injected reader (the server runs locally).
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { redactSecrets } from "@nathapp/nax-agent";
import { inputString, resolveToolPath } from "#src/server/translate/tool-kind";

export type DiffContent = Extract<ToolCallContent, { type: "diff" }>;

export const WRITE_DIFF_OLD_MAX_BYTES = 1024 * 1024;

export type OldText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "too-large" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "outside-workspace" };

/** Reads a Write target's current text; never reads a file whose real path is outside `root` (the session cwd). */
export type ReadOldText = (absolutePath: string, root: string) => Promise<OldText>;

export interface OldTextFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ readonly size: number; isFile(): boolean }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

const NODE_FS: OldTextFs = {
  realpath: (path) => realpath(path),
  stat,
  readFile: (path, encoding) => readFile(path, encoding),
};

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function fsReadOldText(fs: OldTextFs = NODE_FS): ReadOldText {
  return async (path, root) => {
    try {
      // Symlinks resolved on both sides: a link inside the workspace to a file outside it is outside.
      const real = await fs.realpath(path);
      if (!isInside(await fs.realpath(root), real)) return { kind: "outside-workspace" };
      const info = await fs.stat(real);
      if (!info.isFile()) return { kind: "unreadable" };
      if (info.size > WRITE_DIFF_OLD_MAX_BYTES) return { kind: "too-large" };
      return { kind: "text", text: await fs.readFile(real, "utf8") };
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
  const old = await readOld(absolute, cwd);
  switch (old.kind) {
    case "text":
      // Masked as live tool input is (the input's own text arrives masked from the session).
      return { type: "diff", path: absolute, oldText: redactSecrets(old.text), newText };
    case "missing":
      return { type: "diff", path: absolute, oldText: null, newText };
    case "too-large":
    case "unreadable":
    case "outside-workspace":
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
