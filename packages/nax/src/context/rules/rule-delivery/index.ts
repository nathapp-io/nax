/**
 * US-005 (SPEC-lazy-rules-delivery) — the native rule-delivery loop handlers.
 *
 * Workflow mode no longer pushes every rule body into the story brief; the brief
 * carries the rules *index* (`buildRulesIndexSection`, US-003) and a body arrives
 * only when a session touches a file it governs:
 *
 *   - a Read of a governed file is NUDGED — the rule text is prefixed to the
 *     read's result, so the bytes are spent once and on demand;
 *   - a Write or Edit of a governed file whose rule the session has not seen is
 *     BLOCKED once, with the rule text and the retry sentence, exactly as
 *     `createInstructionInteraction` refuses a mutation after new
 *     directory-scoped instructions are discovered. The agent retries and the
 *     second call is allowed.
 *
 * The pair is registered after the plugin handlers at run setup
 * (`configureRunRules`) and scoped by `LoopHandlerContext.role`: read nudges for
 * every workflow role that reads (`RULE_READ_ROLES`), write blocks only for the
 * two roles that may mutate (`RULE_WRITE_ROLES`). An `advisor` session, or a
 * context with no role at all, is never touched — including its Reads.
 *
 * Design notes that are load-bearing:
 *
 *   - **Fail-open.** Every error is caught here and answered with `allow`. The
 *     native loop's own wrapper would log-and-skip a throwing handler too, but a
 *     failing rule lookup must not turn into a refused mutation, and the seam
 *     this module offers is "never take the loop's error path".
 *   - **Run-scoped caches.** `findPackageDir` is cached by directory and each
 *     package's rule set by package, for the life of the run: matching a file
 *     in a package the run has already touched does no file I/O.
 *   - **Per-session delivery.** Delivered rule identities — the rule's file
 *     (`ruleIdentity`), not its id — live in a map keyed by `sessionName`, so
 *     two concurrent sessions each see a body once, and a same-id rule in
 *     another layer or package is still delivered on its own.
 *     `before_compaction` drops one session's entry — a session that has just
 *     had its transcript summarised has also lost the turn that carried the
 *     body.
 *   - **The cap.** A single call's bodies are included in priority order up to
 *     `MAX_RULE_INJECTION_BYTES`; the rest are listed by id and path only and
 *     stay undelivered, so a later call delivers them. The bound is measured on
 *     the BODIES (`Buffer.byteLength`), which is what the spec caps; the heading
 *     and preamble add a few dozen bytes on top. The cap is below half of the
 *     native tool-result ceiling, which a nudged result shares with the file.
 *   - **Rule-file reads come first.** `displayPath` matching runs before the
 *     outside-root and `.nax/` checks, because an override rule's own file is
 *     outside the repo root and a repo rule's file is under `.nax/`. Reading a
 *     rule's file is how a session acknowledges it, so that read marks the rule
 *     delivered and the mutation it unblocks is not refused.
 */

import { isAbsolute, join, posix, relative, resolve } from "node:path";
import {
  type BeforeToolOutcome,
  type BeforeToolPayload,
  type ExternalHandlerOf,
  errorMessage,
  type LoopEvent,
  type LoopHandlerContext,
  type LoopHandlerSet,
  type PayloadOf,
} from "@nathapp/nax-agent/internal";
import { normalizePath, ruleMatchesScopeFiles } from "@/context/engine/scope-path-match";
import { canonicalRulePriority, type ResolvedRule, resolveRuleSet, rulesForFile } from "@/context/rules/rule-set";
import { getLogger } from "@/logger";
import { buildRuleDeliveryText } from "@/prompts";
import { findPackageDir } from "@/test-runners";

// ─────────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────────

/** The most body bytes one call may carry; the rest are listed, not shown. */
export const MAX_RULE_INJECTION_BYTES = 16_384;

/** Roles whose Reads may be nudged. */
export const RULE_READ_ROLES: readonly string[] = Object.freeze([
  "wf-implementer",
  "wf-branch-fix",
  "wf-story-review",
  "wf-rereview",
  "wf-branch-review",
]);

/** Roles whose Writes and Edits may be refused once. */
export const RULE_WRITE_ROLES: readonly string[] = Object.freeze(["wf-implementer", "wf-branch-fix"]);

/** The plugin name every entry this module registers carries. */
export const RULE_DELIVERY_PLUGIN = "nax-rules";

export interface RuleDeliveryInput {
  readonly repoRoot: string;
  readonly overrideDir?: string;
  readonly overrideMode: "merge" | "replace";
}

export const _ruleDeliveryDeps: {
  rulesForFile: typeof rulesForFile;
  resolveRuleSet: typeof resolveRuleSet;
} = { rulesForFile, resolveRuleSet };

/** One before_tool entry and one before_compaction entry, both with plugin "nax-rules". */
export function createRuleDeliveryHandlers(input: RuleDeliveryInput): LoopHandlerSet {
  const state = createState(input);
  // An entry's handler is typed for the whole `LoopEvent` union — the set is
  // frozen and dispatched per the event it names, so nothing narrower can be
  // stored. The `before_tool` handler therefore re-establishes its payload
  // before reading it, exactly as the built-ins do.
  const beforeTool: ExternalHandlerOf<LoopEvent> = (payload, ctx) =>
    isBeforeToolPayload(payload) ? runBeforeTool(state, payload, ctx) : { kind: "allow" };
  const beforeCompaction: ExternalHandlerOf<LoopEvent> = (_payload, ctx) => forgetSession(state, ctx);
  const entries: LoopHandlerSet = [
    { plugin: RULE_DELIVERY_PLUGIN, event: "before_tool", handler: beforeTool },
    { plugin: RULE_DELIVERY_PLUGIN, event: "before_compaction", handler: beforeCompaction },
  ];
  return Object.freeze(entries);
}

/** Only `before_tool`'s payload carries a tool call; it is what this pair reads. */
function isBeforeToolPayload(payload: PayloadOf<LoopEvent>): payload is BeforeToolPayload {
  return "call" in payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/** Cache key for a file with no package boundary above it. */
const ROOT_PACKAGE = "";

interface DeliveryState {
  readonly input: RuleDeliveryInput;
  /** Every rule the handler knows, by delivery identity — the displayPath lookup set. */
  readonly knownRules: Map<string, ResolvedRule>;
  /** `findPackageDir` results, by directory. */
  readonly packageDirByDir: Map<string, Promise<string | undefined>>;
  /** Each package's rule set, by package. */
  readonly ruleSetByPackage: Map<string, Promise<readonly ResolvedRule[]>>;
  /** The per-file resolver's answer for the file that seeded a package. */
  readonly seededRules: Map<string, readonly ResolvedRule[]>;
  /** Delivered rule identities, by session name. */
  readonly deliveredBySession: Map<string, Set<string>>;
  /** The root package's rule set, loaded once per run. */
  rootWarm?: Promise<void>;
}

/**
 * What one delivery is keyed on: the file the rule's text lives in.
 *
 * Not the rule id. Layers merge by id, so a repo rule and a package's own rule
 * of the same id are one entry in one package's set — but they are two files
 * with two bodies, and a session that has seen the repo one has not seen the
 * package's. A cross-package branch review or fix session reads and writes
 * files from both, and keying on the id lets the second rule pass undelivered.
 * `displayPath` is the identity both the resolver and the review map
 * (`review-rules-map.ts`) already use for exactly this reason.
 */
function ruleIdentity(rule: ResolvedRule): string {
  return rule.displayPath;
}

function createState(input: RuleDeliveryInput): DeliveryState {
  return {
    input,
    knownRules: new Map(),
    packageDirByDir: new Map(),
    ruleSetByPackage: new Map(),
    seededRules: new Map(),
    deliveredBySession: new Map(),
  };
}

function remember(state: DeliveryState, rules: readonly ResolvedRule[]): void {
  for (const rule of rules) {
    const identity = ruleIdentity(rule);
    if (!state.knownRules.has(identity)) state.knownRules.set(identity, rule);
  }
}

function sessionRules(state: DeliveryState, sessionName: string): Set<string> {
  const existing = state.deliveredBySession.get(sessionName);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  state.deliveredBySession.set(sessionName, created);
  return created;
}

function isDelivered(state: DeliveryState, sessionName: string, rule: ResolvedRule): boolean {
  return state.deliveredBySession.get(sessionName)?.has(ruleIdentity(rule)) ?? false;
}

function markDelivered(state: DeliveryState, sessionName: string, rules: readonly ResolvedRule[]): void {
  remember(state, rules);
  if (rules.length === 0) return;
  const delivered = sessionRules(state, sessionName);
  for (const rule of rules) delivered.add(ruleIdentity(rule));
}

/** Drop one session's delivered state; a compaction makes its bodies new again. */
function forgetSession(state: DeliveryState, ctx: LoopHandlerContext): undefined {
  try {
    state.deliveredBySession.delete(ctx.sessionName);
  } catch (err) {
    logFailure(ctx, err);
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

interface DeliveryPath {
  /** Repo-relative and normalized — absent when the path lies outside the root. */
  readonly rel?: string;
  /** Absolute and posix-normalized — what an override rule's displayPath names. */
  readonly abs: string;
}

/** The `path` a file tool was called with, whatever shape the model sent. */
function inputPath(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("path" in input)) return undefined;
  return input.path;
}

function insideRoot(rel: string): boolean {
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/**
 * Normalize a tool's `path` for matching: `./x` and `a/../x` both become `x`, an
 * absolute path inside the repo root becomes its relative spelling, and a path
 * that normalizes outside the root keeps only its absolute form.
 */
function toDeliveryPath(raw: unknown, repoRoot: string): DeliveryPath | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  const normalized = normalizePath(raw);
  if (!isAbsolute(normalized)) {
    const rel = posix.normalize(normalized);
    const abs = posix.normalize(resolve(repoRoot, rel));
    return insideRoot(rel) ? { rel, abs } : { abs };
  }
  const abs = posix.normalize(normalized);
  const rel = relative(repoRoot, abs);
  return insideRoot(rel) ? { rel: posix.normalize(rel), abs } : { abs };
}

function samePath(a: string, b: string): boolean {
  return posix.normalize(normalizePath(a)) === posix.normalize(normalizePath(b));
}

/**
 * The rule whose own file this path is, if the handler knows it. An override
 * rule is named by its absolute path, a repo or package rule by its
 * repo-relative one — the spelling `ResolvedRule.displayPath` carries.
 */
function matchRuleFile(state: DeliveryState, path: DeliveryPath): ResolvedRule | undefined {
  for (const rule of state.knownRules.values()) {
    const candidate = rule.source === "override" ? path.abs : path.rel;
    if (candidate !== undefined && samePath(candidate, rule.displayPath)) return rule;
  }
  return undefined;
}

/** `.nax/` is nax's own state — a rule never governs a read of it. */
function isNaxPath(rel: string): boolean {
  return rel === ".nax" || rel.startsWith(".nax/") || rel.includes("/.nax/");
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution (cached for the life of the run)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The root package's rule set, loaded on the handler's first call.
 *
 * It is what makes a read of `.nax/rules/<id>.md` — or of an override rule's
 * file — recognisable before any governed file has been read at all. A rejection
 * is not cached: a transient read failure must not poison every later call.
 */
function warmRoot(state: DeliveryState): Promise<void> {
  const warm = state.rootWarm ?? loadRootRules(state);
  state.rootWarm = warm;
  warm.catch(() => {
    if (state.rootWarm === warm) state.rootWarm = undefined;
  });
  return warm;
}

async function loadRootRules(state: DeliveryState): Promise<void> {
  const { repoRoot, overrideDir, overrideMode } = state.input;
  const set = await _ruleDeliveryDeps.resolveRuleSet({
    repoRoot,
    packageDir: repoRoot,
    ...(overrideDir !== undefined && { overrideDir }),
    overrideMode,
  });
  remember(state, set.rules);
}

async function packageForDir(state: DeliveryState, dir: string, rel: string): Promise<string | undefined> {
  const cached = state.packageDirByDir.get(dir);
  if (cached !== undefined) return cached;
  const lookup = findPackageDir(rel, state.input.repoRoot);
  state.packageDirByDir.set(dir, lookup);
  lookup.catch(() => state.packageDirByDir.delete(dir));
  return lookup;
}

/**
 * The package's whole rule set, resolved once.
 *
 * The first file of a package is answered by `rulesForFile` — the per-file
 * resolver, and the seam a consumer stubs — and its answer is kept for that one
 * file. The package's own set is resolved alongside it because a rule set is per
 * package, not per file: with it, the package's other files match from cache, so
 * a rule that governs only the *second* file read is delivered rather than
 * silently missed, and no further lookup happens.
 */
async function packageRuleSet(state: DeliveryState, key: string, packageRel: string | undefined, rel: string) {
  const cached = state.ruleSetByPackage.get(key);
  if (cached !== undefined) return cached;
  const loaded = loadPackageRuleSet(state, packageRel, rel);
  state.ruleSetByPackage.set(key, loaded);
  loaded.catch(() => state.ruleSetByPackage.delete(key));
  return loaded;
}

async function loadPackageRuleSet(
  state: DeliveryState,
  packageRel: string | undefined,
  rel: string,
): Promise<readonly ResolvedRule[]> {
  const { repoRoot, overrideDir, overrideMode } = state.input;
  const fileRules = await _ruleDeliveryDeps.rulesForFile({
    repoRoot,
    path: rel,
    ...(overrideDir !== undefined && { overrideDir }),
    overrideMode,
  });
  remember(state, fileRules);
  state.seededRules.set(rel, fileRules);

  const set = await _ruleDeliveryDeps.resolveRuleSet({
    repoRoot,
    packageDir: packageRel === undefined ? repoRoot : join(repoRoot, packageRel),
    ...(packageRel !== undefined && { storyWorkdir: packageRel }),
    ...(overrideDir !== undefined && { overrideDir }),
    overrideMode,
  });
  remember(state, set.rules);
  return set.rules;
}

/** The rules governing one repo-relative file, in priority order. */
async function governingRules(state: DeliveryState, rel: string): Promise<readonly ResolvedRule[]> {
  const dir = posix.dirname(rel);
  const packageRel = await packageForDir(state, dir, rel);
  const packageRules = await packageRuleSet(state, packageRel ?? ROOT_PACKAGE, packageRel, rel);
  const matched = packageRules.filter((rule) => ruleMatchesScopeFiles([...(rule.appliesTo ?? [])], [rel]));
  const seeded = state.seededRules.get(rel);
  return seeded === undefined ? matched : dedupeByIdentity([...seeded, ...matched]);
}

/** Keyed by delivery identity, so two same-id rules of different packages both survive. */
function dedupeByIdentity(rules: readonly ResolvedRule[]): ResolvedRule[] {
  const byIdentity = new Map<string, ResolvedRule>();
  for (const rule of rules) {
    const identity = ruleIdentity(rule);
    if (!byIdentity.has(identity)) byIdentity.set(identity, rule);
  }
  return [...byIdentity.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// The before_tool decision
// ─────────────────────────────────────────────────────────────────────────────

/** Only these three tools trigger delivery; every other call is left alone. */
function deliveryModeFor(toolName: string): "read" | "write" | undefined {
  if (toolName === "Read") return "read";
  if (toolName === "Write" || toolName === "Edit") return "write";
  return undefined;
}

/** No role, or a role the mode does not list, is never touched. */
function roleAllows(role: string | undefined, mode: "read" | "write"): boolean {
  if (role === undefined) return false;
  return (mode === "read" ? RULE_READ_ROLES : RULE_WRITE_ROLES).includes(role);
}

async function runBeforeTool(
  state: DeliveryState,
  payload: BeforeToolPayload,
  ctx: LoopHandlerContext,
): Promise<BeforeToolOutcome> {
  try {
    const mode = deliveryModeFor(payload.call.name);
    if (mode === undefined || !roleAllows(ctx.role, mode)) return { kind: "allow" };

    await warmRoot(state);
    const path = toDeliveryPath(inputPath(payload.call.input), state.input.repoRoot);
    if (path === undefined) return { kind: "allow" };

    const ruleFile = matchRuleFile(state, path);
    if (ruleFile !== undefined) {
      markDelivered(state, ctx.sessionName, [ruleFile]);
      return { kind: "allow" };
    }
    if (path.rel === undefined || isNaxPath(path.rel)) return { kind: "allow" };

    const undelivered = (await governingRules(state, path.rel)).filter(
      (rule) => !isDelivered(state, ctx.sessionName, rule),
    );
    return undelivered.length === 0 ? { kind: "allow" } : deliver(state, ctx, path.rel, undelivered, mode);
  } catch (err) {
    logFailure(ctx, err);
    return { kind: "allow" };
  }
}

/** Hand over the undelivered rules this call may carry, and mark them delivered. */
function deliver(
  state: DeliveryState,
  ctx: LoopHandlerContext,
  rel: string,
  undelivered: readonly ResolvedRule[],
  mode: "read" | "write",
): BeforeToolOutcome {
  const { shown, listed } = splitByCap(sortByPriority(undelivered));
  const text = buildRuleDeliveryText({ path: rel, delivered: shown, listedOnly: listed, mode });
  markDelivered(state, ctx.sessionName, shown);
  getLogger().info("rules", "rules.delivered", {
    storyId: ctx.storyId,
    sessionName: ctx.sessionName,
    path: rel,
    ruleIds: shown.map((rule) => rule.ruleId),
    listedRuleIds: listed.map((rule) => rule.ruleId),
  });
  return mode === "write" ? { kind: "block", content: text, isError: true } : { kind: "nudge", text };
}

/** Priority ascending, then rule id (code-point, matching the resolver's order). */
function sortByPriority(rules: readonly ResolvedRule[]): ResolvedRule[] {
  return [...rules].sort((a, b) => {
    const byPriority = canonicalRulePriority(a) - canonicalRulePriority(b);
    if (byPriority !== 0) return byPriority;
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
  });
}

function splitByCap(rules: readonly ResolvedRule[]): { shown: ResolvedRule[]; listed: ResolvedRule[] } {
  const shown: ResolvedRule[] = [];
  const listed: ResolvedRule[] = [];
  let used = 0;
  for (const rule of rules) {
    const bytes = Buffer.byteLength(rule.content, "utf8");
    if (used + bytes > MAX_RULE_INJECTION_BYTES) {
      listed.push(rule);
    } else {
      shown.push(rule);
      used += bytes;
    }
  }
  return { shown, listed };
}

function logFailure(ctx: LoopHandlerContext, err: unknown): void {
  getLogger().warn("rules", "rule delivery failed; leaving the call alone", {
    storyId: ctx.storyId,
    sessionName: ctx.sessionName,
    error: errorMessage(err),
  });
}
