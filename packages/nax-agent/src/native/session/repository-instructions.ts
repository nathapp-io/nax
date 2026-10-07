/** Bounded, repository-local instruction discovery. Each instance belongs to one session. */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { readPrefix } from "#src/internal/bounded-io";
import { credentialReadRefusal } from "#src/tools/credential-read-deny";
import { matchesDenyPaths } from "#src/tools/deny-paths";
import type { ProtectedPathsPolicy } from "#src/tools/protected-paths";
import { MIN_INSTRUCTION_NOTICE_BYTES, renderRepositoryInstructions } from "./instruction-render.ts";

export const _repositoryInstructionDeps = { realpath, readPrefix };
const MAX_FILE_BYTES = 32_768;
const MAX_TOTAL_BYTES = 131_072;
const MAX_FILES = 64;
const MAX_DEPTH = 8;
export interface InstructionSource {
  readonly path: string;
  readonly scope: string;
  readonly hash: string;
}
interface LoadedSource extends InstructionSource {
  readonly text: string;
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function safeMarkdown(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    contained(root, path) &&
    /\.md$/i.test(path) &&
    !rel.split(sep).some((part) => part.startsWith(".") || /(?:credential|secret|trust[-_]?store)/i.test(part))
  );
}
export class RepositoryInstructions {
  private readonly loaded = new Map<string, LoadedSource>();
  private readonly visited = new Set<string>();
  private readonly scopes = new Set<string>();
  private bytes = 0;
  private root: string | undefined;
  private limited = false;
  private pending: Promise<void> = Promise.resolve();
  private renderMaxBytes = Number.POSITIVE_INFINITY;
  constructor(
    private readonly workdir: string,
    private readonly protectedPaths?: ProtectedPathsPolicy,
    private readonly denyPaths?: readonly string[],
  ) {}
  get directories(): readonly string[] {
    return [...this.scopes];
  }
  get sources(): readonly InstructionSource[] {
    return [...this.loaded.values()].map(({ path, scope, hash }) => ({
      path,
      scope,
      hash,
    }));
  }
  /** Bytes conservatively upper-bound token count; host instructions consume the same system reserve. */
  setContextBudget(contextWindow: number | undefined, hostPrompt: string | undefined): void {
    const reserve = Math.floor((contextWindow ?? 16_384) / 4);
    const hostBytes = Buffer.byteLength(hostPrompt ?? "", "utf8") + 2;
    // The caller owns its host prompt. When that already consumes the reserve,
    // retain only the explicit omission notice rather than silently losing guides.
    this.renderMaxBytes = Math.max(MIN_INSTRUCTION_NOTICE_BYTES, reserve - hostBytes);
  }
  render(): string {
    return renderRepositoryInstructions([...this.loaded.values()], this.limited, this.renderMaxBytes);
  }
  discover(
    directory: string,
    canRead: (path: string) => boolean = () => true,
    protectedPaths = this.protectedPaths,
  ): Promise<void> {
    const next = this.pending.then(() => this.discoverScope(directory, canRead, protectedPaths));
    this.pending = next.catch(() => {});
    return next;
  }
  private async discoverScope(
    directory: string,
    canRead: (path: string) => boolean,
    protectedPaths?: ProtectedPathsPolicy,
  ): Promise<void> {
    this.root ??= await _repositoryInstructionDeps.realpath(this.workdir).catch(() => resolve(this.workdir));
    const lexical = resolve(this.workdir, directory);
    if (!contained(resolve(this.workdir), lexical) && !contained(this.root, lexical)) return;
    const target = await _repositoryInstructionDeps.realpath(lexical).catch(() => lexical);
    if (!contained(this.root, target)) return;
    const rel = relative(this.root, target);
    if (rel.split(sep).some((part) => part.startsWith(".") && part !== "")) return;
    const parts = rel === "" ? [] : rel.split(sep);
    if (parts.length > 32) {
      this.limited = true;
      return;
    }
    this.scopes.add(rel || ".");
    let dir = this.root;
    for (const part of ["", ...parts]) {
      if (part !== "") dir = resolve(dir, part);
      for (const name of ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"]) {
        const found = await this.load(resolve(dir, name), relative(this.root, dir) || ".", 0, canRead, protectedPaths);
        if (found) break;
      }
    }
  }
  private async load(
    path: string,
    scope: string,
    depth: number,
    canRead: (path: string) => boolean,
    protectedPaths?: ProtectedPathsPolicy,
  ): Promise<boolean> {
    if (this.root === undefined) return false;
    if (depth > MAX_DEPTH || this.visited.size >= MAX_FILES || this.bytes >= MAX_TOTAL_BYTES) {
      this.limited = true;
      return false;
    }
    if (
      !safeMarkdown(this.root, path) ||
      credentialReadRefusal(protectedPaths, path) !== undefined ||
      credentialReadRefusal(this.protectedPaths, path) !== undefined ||
      !canRead(path) ||
      matchesDenyPaths(relative(this.root, path).split(sep).join("/"), this.denyPaths)
    )
      return false;
    const canonical = await _repositoryInstructionDeps.realpath(path).catch(() => undefined);
    if (
      canonical === undefined ||
      !safeMarkdown(this.root, canonical) ||
      credentialReadRefusal(protectedPaths, canonical) !== undefined ||
      credentialReadRefusal(this.protectedPaths, canonical) !== undefined ||
      !canRead(canonical) ||
      matchesDenyPaths(relative(this.root, canonical).split(sep).join("/"), this.denyPaths)
    )
      return false;
    if (this.visited.has(canonical)) return true;
    this.visited.add(canonical);
    const text = await _repositoryInstructionDeps
      .readPrefix(canonical, Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - this.bytes))
      .catch(() => undefined);
    if (text === undefined) return false;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_FILE_BYTES || this.bytes + bytes > MAX_TOTAL_BYTES) {
      this.limited = true;
      return true;
    }
    this.bytes += bytes;
    if (text.trim() === "") return true;
    const hash = createHash("sha256").update(text).digest("hex");
    this.loaded.set(canonical, {
      path: relative(this.root, canonical),
      scope,
      hash,
      text,
    });
    // Claude-style @path imports: local markdown only, never URLs or home paths.
    for (const match of text.matchAll(/(?:^|\s)@([^\s`<>]+\.md)(?=\s|$)/gm)) {
      const imported = match[1];
      if (imported === undefined || isAbsolute(imported) || imported.startsWith("~") || imported.includes(":"))
        continue;
      await this.load(resolve(dirname(canonical), imported), scope, depth + 1, canRead, protectedPaths);
    }
    return true;
  }
}
