#!/usr/bin/env bun
/**
 * Guard: every `CallContext` built in `src/` carries the ask resolver and the
 * command shadow, unless it is explicitly allowlisted as dispatching no
 * Bash-declaring operation (#2202).
 *
 * Why this exists: `bashApproval: gated | escalate` answers an `ask` verdict
 * through `CallContext.askResolver`, and the P5 shadow classifies commands
 * through `CallContext.commandShadow`. The tool runtime silently falls back to
 * `headlessAskResolver()` (always deny, no approval-audit row) and to no shadow
 * tap when either is absent. #2201 found three call sites -- the finish phase,
 * the acceptance fix cycle and the deferred regression gate -- that dispatched
 * Bash-declaring ops without either, so escalation was structurally
 * unreachable there while the inert-Bash pre-flight warning (#2192) reported
 * clean. Every such site now builds its wiring through
 * `buildDispatchAskWiring` / `buildRunDispatchAskWiring` (src/interaction);
 * this gate keeps a fourth from being added without one.
 *
 * What counts as a construction: an object literal whose top-level members
 * include `runtime`, `packageView` and `agentName` -- the required core of
 * `CallContext` (and so of `FixCycleContext`). Matching on the members rather
 * than on a `: CallContext` annotation also catches an unannotated literal
 * passed straight to `callOp`. Each is classified:
 *
 *   wired    names both `askResolver` and `commandShadow` (as a member, or
 *            inside a spread such as `...(commandShadow ? { commandShadow } : {})`)
 *   bare     anything else -- a violation unless allowlisted below
 *
 * A plain spread (`{ ...callCtx, runtime, ... }`, `{ ...baseOpts, ... }`) does
 * not satisfy the requirement: the scanner cannot see what the spread source
 * carries, and trusting it would let a resolver-less base object reopen #2201.
 * A literal derived from an existing context names both fields explicitly
 * (`askResolver: callCtx.askResolver, commandShadow: callCtx.commandShadow`)
 * or is allowlisted like any other bare site.
 *
 * Deny by default: a new construction site fails until it is wired or someone
 * adds an ALLOWED_BARE_SITES entry saying why it can never dispatch Bash. An
 * allowlisted file must not reference any Bash-declaring op (or an operations
 * export whose source names one, e.g. a strategy factory), computed from the
 * operations barrel the way check-op-tool-capability reads it. That reference
 * check sees the file only: a context handed to another module that dispatches
 * a Bash op on its behalf (the finish phase's `createFinishOps(callCtx)`) is not
 * traced, which is exactly why such sites are wired rather than allowlisted.
 * An allowlist entry that no longer matches a bare site fails as stale.
 *
 * Source-text, like the other `scripts/check-*` gates (the repo's TypeScript is
 * the native compiler, which ships no JS AST API): comments and string
 * literals are blanked first, then object literals are split into top-level
 * members by delimiter depth.
 *
 * Usage: bun run scripts/check-bash-dispatch-ask.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveDeclaredTools } from "../src/operations/types";
import { BASH_TOOL_NAME } from "../src/tools";
import { byCodePoint } from "../src/utils/sort";

const ROOT = join(import.meta.dir, "..");
const SCAN_DIR = "src";

/** Top-level members that identify a `CallContext` construction. */
export const CONTEXT_CORE_FIELDS = ["runtime", "packageView", "agentName"] as const;

/** Fields a Bash-capable dispatch context must carry. */
export const REQUIRED_FIELDS = ["askResolver", "commandShadow"] as const;

export type SiteKind = "wired" | "bare";

export interface ContextSite {
  readonly file: string;
  readonly line: number;
  /** Enclosing function (or `<module>`), the allowlist key alongside the file. */
  readonly fn: string;
  readonly kind: SiteKind;
  /** REQUIRED_FIELDS the literal does not name (empty unless `bare`). */
  readonly missing: readonly string[];
}

export interface AllowedBareSite {
  readonly file: string;
  readonly fn: string;
  /** Why this context can never reach a Bash-declaring op. */
  readonly reason: string;
}

/**
 * Construction sites that dispatch no Bash-declaring op. Each reason names the
 * ops the context is used for; none of them declares `Bash`.
 */
export const ALLOWED_BARE_SITES: readonly AllowedBareSite[] = [
  { file: "src/routing/router.ts", fn: "resolveRouting", reason: "classifyRouteOp (complete-kind, no tools)" },
  { file: "src/routing/router.ts", fn: "tryLlmBatchRoute", reason: "classifyRouteBatchOp (complete-kind, no tools)" },
  { file: "src/plan/strategies/single.ts", fn: "execute", reason: "planInteractiveOp (Read/Glob/Grep/Write)" },
  { file: "src/plan/strategies/refine.ts", fn: "execute", reason: "planRefineOp (Read/Glob/Grep/Write)" },
  { file: "src/cli/setup.ts", fn: "buildCallContext", reason: "setupGenerateOp (read-only default tools)" },
  { file: "src/cli/plan-decompose.ts", fn: "planDecomposeCommand", reason: "decomposeOp (complete-kind)" },
  {
    file: "src/acceptance/hardening.ts",
    fn: "processPackageGroup",
    reason: "acceptanceRefineOp (complete-kind) / acceptanceGenerateOp (Read/Glob/Grep/Write)",
  },
  {
    file: "src/pipeline/stages/acceptance-setup.ts",
    fn: "callOp",
    reason:
      "_acceptanceSetupDeps.callOp, used only for acceptanceRefineOp (complete-kind) / acceptanceGenerateOp (Read/Glob/Grep/Write)",
  },
  { file: "src/execution/lifecycle/acceptance-fix.ts", fn: "fixCallCtx", reason: "acceptanceDiagnoseOp (read-only)" },
];

// ─── Source scan ─────────────────────────────────────────────────────────────

/** Blank comments and string/template literals, preserving offsets and newlines. */
export function blankNonCode(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, text.length);
      blank(i, stop);
      i = stop;
    } else {
      i++;
    }
  }
  return out.join("");
}

const OPENERS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const CLOSERS = new Set(Object.values(OPENERS));

/** Index of the brace closing the one at `openIdx`, or -1 when unbalanced. */
function matchBrace(code: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split an object literal's body into top-level members (comma-separated at depth 0). */
export function topLevelMembers(body: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (OPENERS[ch] !== undefined) depth++;
    else if (CLOSERS.has(ch)) depth--;
    else if (ch === "," && depth === 0) {
      members.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  members.push(body.slice(start).trim());
  return members.filter((m) => m.length > 0);
}

/** The key a member defines (`key: v`, shorthand `key`, `key(...)`), or undefined for a spread. */
export function memberKey(member: string): string | undefined {
  if (member.startsWith("...")) return undefined;
  return /^(?:async\s+)?([A-Za-z_$][\w$]*)/.exec(member)?.[1];
}

function classify(members: readonly string[]): { kind: SiteKind; missing: string[] } {
  const missing = REQUIRED_FIELDS.filter(
    (field) =>
      !members.some((m) => memberKey(m) === field || (m.startsWith("...") && new RegExp(`\\b${field}\\b`).test(m))),
  );
  return missing.length === 0 ? { kind: "wired", missing } : { kind: "bare", missing };
}

const FN_HEADS: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*(?:async\s*)?\(|\()/,
];
const NOT_FN_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "await", "function"]);

/** Nearest less-indented function head above `line` (0-based), or `<module>`. */
function enclosingFunctionName(lines: readonly string[], line: number): string {
  let indent = (lines[line] ?? "").search(/\S/);
  for (let i = line - 1; i >= 0; i--) {
    const text = lines[i] ?? "";
    const own = text.search(/\S/);
    // A closing line (`): Promise<T> {`, `} else {`) is the tail of a construct
    // whose head sits further up at the same indent -- it opens no scope of its own.
    if (own === -1 || own >= indent || /^\s*[)\]}]/.test(text)) continue;
    indent = own;
    for (const head of FN_HEADS) {
      const name = head.exec(text)?.[1];
      if (name !== undefined && !NOT_FN_NAMES.has(name)) return name;
    }
  }
  return "<module>";
}

/** Every `CallContext` construction in one source file. */
export function findContextSites(file: string, source: string): ContextSite[] {
  const code = blankNonCode(source);
  const lines = code.split("\n");
  const sites: ContextSite[] = [];
  for (let open = code.indexOf("{"); open !== -1; open = code.indexOf("{", open + 1)) {
    const close = matchBrace(code, open);
    if (close === -1) break;
    const members = topLevelMembers(code.slice(open + 1, close));
    const keys = new Set(members.map(memberKey));
    if (!CONTEXT_CORE_FIELDS.every((field) => keys.has(field))) continue;
    const line = code.slice(0, open).split("\n").length - 1;
    sites.push({ file, line: line + 1, fn: enclosingFunctionName(lines, line), ...classify(members) });
  }
  return sites;
}

// ─── Bash-carrying names ─────────────────────────────────────────────────────

/**
 * Export names of the operations barrel that carry a Bash-declaring op: the
 * ops themselves under every alias, plus any exported function whose source
 * names one of them (a strategy factory such as `makeFullSuiteRectifyStrategy`).
 */
export function bashCarryingNames(mod: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "object" || value === null) continue;
    const op = value as { kind?: unknown; tools?: Parameters<typeof resolveDeclaredTools>[0]["tools"] };
    if (op.kind !== "run") continue;
    if (resolveDeclaredTools(op).includes(BASH_TOOL_NAME)) names.add(name);
  }
  const opNames = [...names];
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "function") continue;
    const text = Function.prototype.toString.call(value);
    if (opNames.some((op) => new RegExp(`\\b${op}\\b`).test(text))) names.add(name);
  }
  return names;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

export interface Findings {
  /** Bare sites not covered by the allowlist. */
  readonly violations: readonly ContextSite[];
  /** Allowlist entries matching no bare site. */
  readonly stale: readonly AllowedBareSite[];
  /** Allowlisted files that reference a Bash-carrying name. */
  readonly leaks: readonly { file: string; names: string[] }[];
}

export function evaluate(
  sites: readonly ContextSite[],
  allowlist: readonly AllowedBareSite[],
  sources: ReadonlyMap<string, string>,
  bashNames: ReadonlySet<string>,
): Findings {
  const key = (s: { file: string; fn: string }): string => `${s.file}#${s.fn}`;
  const allowed = new Set(allowlist.map(key));
  const bare = sites.filter((s) => s.kind === "bare");
  const violations = bare.filter((s) => !allowed.has(key(s)));
  const bareKeys = new Set(bare.map(key));
  const stale = allowlist.filter((entry) => !bareKeys.has(key(entry)));
  const leaks: { file: string; names: string[] }[] = [];
  for (const file of new Set(allowlist.map((e) => e.file))) {
    const code = blankNonCode(sources.get(file) ?? "");
    const names = [...bashNames].filter((n) => new RegExp(`\\b${n}\\b`).test(code)).sort(byCodePoint);
    if (names.length > 0) leaks.push({ file, names });
  }
  return { violations, stale, leaks };
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listSourceFiles(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function report(findings: Findings): boolean {
  for (const v of findings.violations) {
    console.error(`  ${v.file}:${v.line} (${v.fn}) builds a CallContext without: ${v.missing.join(", ")}`);
  }
  for (const s of findings.stale) {
    console.error(`  stale allowlist entry: ${s.file}#${s.fn} matches no bare CallContext construction`);
  }
  for (const l of findings.leaks) {
    console.error(`  allowlisted ${l.file} references Bash-declaring op(s): ${l.names.join(", ")}`);
  }
  return findings.violations.length + findings.stale.length + findings.leaks.length > 0;
}

/** Scan the real `src/` tree against the real allowlist and operations barrel. */
export async function scanTree(root: string = ROOT): Promise<{ sites: ContextSite[]; findings: Findings }> {
  const sources = new Map<string, string>();
  const sites: ContextSite[] = [];
  for (const abs of listSourceFiles(join(root, SCAN_DIR))) {
    const file = relative(root, abs);
    const source = readFileSync(abs, "utf8");
    sources.set(file, source);
    sites.push(...findContextSites(file, source));
  }
  const mod = (await import("../src/operations")) as Record<string, unknown>;
  return { sites, findings: evaluate(sites, ALLOWED_BARE_SITES, sources, bashCarryingNames(mod)) };
}

async function main(): Promise<void> {
  const { sites, findings } = await scanTree();
  if (report(findings)) {
    console.error("\n[FAIL] a CallContext that can dispatch a Bash-declaring op must carry askResolver and");
    console.error("commandShadow -- build them with buildDispatchAskWiring / buildRunDispatchAskWiring");
    console.error("(src/interaction) and dispose the wiring when the scope ends. Without them");
    console.error("bashApproval gated|escalate silently always-denies and nothing is shadow-classified (#2201).");
    console.error("A site that can never dispatch Bash goes in ALLOWED_BARE_SITES with its reason.");
    process.exit(1);
  }
  const counts = { wired: 0, bare: 0 };
  for (const s of sites) counts[s.kind]++;
  console.log(`OK: ${sites.length} CallContext construction(s): ${counts.wired} wired, ${counts.bare} allowlisted.`);
}

if (import.meta.main) await main();
