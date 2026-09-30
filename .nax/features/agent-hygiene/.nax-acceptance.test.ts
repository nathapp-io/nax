import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import * as codingToolSandbox from "@/agents/coding-tool-sandbox";
import { rawRefusalFor, resolveSessionSandbox } from "@/agents/coding-tool-sandbox";
import { buildCodingToolSupport, buildLedgerSessionName, resolveCodingToolSupport } from "@/agents/coding-tool-support";
import { nativeSessionScratchpadRoots, nativeTranscriptDirs } from "@/agents/native/session/session";
import { truncateNativeToolResult } from "@/agents/native/session/truncation-handler";
import { appendCommandSafetyRow, createCommandShadow, RULE_SET_VERSION } from "@/command-safety";
import { DEFAULT_CONFIG } from "@/config";
import * as nonBlockingFixModule from "@/execution/non-blocking-fix";
import { _nonBlockingFixDeps, createMeasureSourceDiff, runNonBlockingFix } from "@/execution/non-blocking-fix";
import { _runCleanupDeps, cleanupRun } from "@/execution/lifecycle/run-cleanup";
import { initLogger, resetLogger } from "@/logger";
import { buildScratchpadSection } from "@/prompts/sections/scratchpad";
import * as sandboxModule from "@/sandbox";
import {
  _launcherDeps,
  createCommandLauncher,
  DISABLED_SANDBOX_STATE,
  type SandboxBackend,
  type SandboxPolicy,
} from "@/sandbox";
import {
  _spillDeps,
  applyModelTruncationPolicy,
  compileToolPolicy,
  createBashTool,
  createCodingToolRuntime,
  MODEL_MAX_BYTES,
  resolveWithin,
  scratchpadReadTool,
} from "@/tools";
import { screenRawBashCommand } from "@/tools/policy-bash-raw";

// ─── shared helpers ────────────────────────────────────────────────────────

type AnyRecord = Record<string, unknown>;

const createdDirs: string[] = [];
const restores: (() => void)[] = [];

/** Fixed paths this file uses and must not leave behind. */
const FIXED_TMP_PATHS = ["/tmp/nax-test", "/tmp/nax-r1"];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const path of FIXED_TMP_PATHS) rmSync(path, { recursive: true, force: true });
  // The native session registries are process-global; this satellite is the
  // only writer of the ids it registers, so clearing them is the isolation.
  nativeSessionScratchpadRoots.clear();
  nativeTranscriptDirs.clear();
  resetLogger();
});

/**
 * Temporarily replace keys on a mutable deps object.
 *
 * A key that did not exist before is *deleted* on restore rather than set back
 * to `undefined`, so a criterion that installs a not-yet-present seam cannot
 * change what later criteria see.
 */
function patchDeps(target: object, values: AnyRecord): void {
  const record = target as AnyRecord;
  const saved = new Map<string, { had: boolean; value: unknown }>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, { had: Object.hasOwn(record, key), value: record[key] });
    record[key] = value;
  }
  restores.push(() => {
    for (const [key, entry] of saved) {
      if (entry.had) record[key] = entry.value;
      else delete record[key];
    }
  });
}

/** Patch the launcher's injectable deps in place, restoring them after the test. */
function patchLauncherDeps(values: Partial<typeof _launcherDeps>): void {
  patchDeps(_launcherDeps, values as AnyRecord);
}

type AnySpy = ReturnType<typeof spyOn>;

/** Spy on both logger levels for the duration of `fn` (same contract as @test/helpers). */
async function withLogSpies<T>(fn: (spies: { info: AnySpy; warn: AnySpy }) => Promise<T>): Promise<T> {
  resetLogger();
  const logger = initLogger({ level: "silent" });
  const info = spyOn(logger, "info");
  const warn = spyOn(logger, "warn");
  try {
    return await fn({ info, warn });
  } finally {
    info.mockRestore();
    warn.mockRestore();
    resetLogger();
  }
}

/** Every argument tuple of every call made through a bun spy. */
function spyCalls(spy: AnySpy): unknown[][] {
  return (spy as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

/** The first call whose second argument (the log message) equals `message`. */
function firstCallWithMessage(spy: AnySpy, message: string): unknown[] | undefined {
  return spyCalls(spy).find((args) => args[1] === message);
}

/** A named export of a module the feature ADDS, or a loud failure. */
function newlyExported<T>(module: object, moduleName: string, symbol: string): T {
  const value = (module as AnyRecord)[symbol];
  if (value === undefined) throw new Error(`${moduleName} does not export ${symbol} yet`);
  return value as T;
}

// ─── symbols the feature adds (US-002 / US-004 / US-005) ──────────────────

/**
 * `rawScreenOptionsFor` and the two `session-tmp` helpers land with this
 * feature. They are read off their module namespaces at call time so a
 * partially-implemented tree still runs every other criterion.
 */
function rawScreenOptionsFor(launcher: unknown): AnyRecord {
  const fn = newlyExported<(l: unknown) => AnyRecord>(
    codingToolSandbox,
    "@/agents/coding-tool-sandbox",
    "rawScreenOptionsFor",
  );
  return fn(launcher);
}

function sessionTmpDir(runId: string, sessionName: string): string {
  const fn = newlyExported<(r: string, s: string) => string>(sandboxModule, "@/sandbox", "sessionTmpDir");
  return fn(runId, sessionName);
}

function runTmpRoot(runId: string): string {
  const fn = newlyExported<(r: string) => string>(sandboxModule, "@/sandbox", "runTmpRoot");
  return fn(runId);
}

/** `src/execution/lifecycle/run-tmp-wipe.ts` — new module, so imported lazily. */
async function loadRunTmpWipe(): Promise<{
  wipeRunTmp: (runId: string, opts?: AnyRecord) => Promise<void>;
  deps: AnyRecord;
}> {
  const mod = (await import("@/execution/lifecycle/run-tmp-wipe")) as AnyRecord;
  const wipeRunTmp = mod.wipeRunTmp;
  const deps = mod._runTmpWipeDeps;
  if (typeof wipeRunTmp !== "function") throw new Error("run-tmp-wipe must export wipeRunTmp");
  if (typeof deps !== "object" || deps === null) throw new Error("run-tmp-wipe must export _runTmpWipeDeps");
  return { wipeRunTmp: wipeRunTmp as never, deps: deps as AnyRecord };
}

/** `src/command-safety/tmp-write.ts` — new module, so imported lazily. */
async function loadDetectTmpWrite(): Promise<(command: string, cwd?: string) => boolean> {
  const mod = (await import("@/command-safety/tmp-write")) as AnyRecord;
  const fn = mod.detectTmpWrite;
  if (typeof fn !== "function") throw new Error("src/command-safety/tmp-write.ts must export detectTmpWrite");
  return fn as never;
}

// ─── spill-marker helpers (US-001) ────────────────────────────────────────

const WIDEST_MARKER_RE =
  /^\.\.\. \[truncated: full output at (.+) \(open with Read or ScratchpadRead\); showing (\d+) of (\d+) bytes\]$/;
const NARROW_MARKER_RE = /^\.\.\. \[truncated: showing (\d+) of (\d+) bytes\]$/;

interface SpillMarker {
  /** The marker line, verbatim. */
  readonly line: string;
  /** The path the marker names. */
  readonly path: string;
  /** `N` as the marker reports it. */
  readonly reportedDeliveredBytes: number;
  /** `M` as the marker reports it. */
  readonly reportedOriginalBytes: number;
  /**
   * The UTF-8 byte length of the body text still delivered — every line of the
   * content except the marker line, joined by the newlines separating them.
   * That is exactly the quantity the marker's `N` must equal.
   */
  readonly deliveredBodyBytes: number;
}

function spillMarker(content: string): SpillMarker {
  const lines = content.split("\n");
  const index = lines.findIndex((line) => line.startsWith("... [truncated: full output at "));
  if (index === -1) throw new Error(`no spill marker in content: ${content.slice(0, 400)}`);
  const line = lines[index] as string;
  const match = WIDEST_MARKER_RE.exec(line);
  if (match === null) throw new Error(`malformed spill marker: ${line}`);
  const delivered = [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n");
  return {
    line,
    path: match[1] as string,
    reportedDeliveredBytes: Number(match[2]),
    reportedOriginalBytes: Number(match[3]),
    deliveredBodyBytes: Buffer.byteLength(delivered, "utf8"),
  };
}

/** A body comfortably over the small byte caps the spill ACs use. */
function bodyFor(lines: number, lineChars: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i} ${"y".repeat(lineChars)}`).join("\n");
}

/** `ScratchpadRead` leads every read with a `[N lines]` header; strip it. */
function readBody(content: string): string {
  const breakAt = content.indexOf("\n");
  if (breakAt === -1) return content;
  const firstLine = content.slice(0, breakAt);
  return /^\[\d+\+? lines\]$/.test(firstLine) ? content.slice(breakAt + 1) : content;
}

// ─── git helpers (US-003) ─────────────────────────────────────────────────

function runGitProcess(cwd: string, args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function git(cwd: string, args: readonly string[]): string {
  const out = runGitProcess(cwd, args);
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${out.stderr}`);
  return out.stdout.trim();
}

function writeIn(dir: string, relPath: string, contents: string): void {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

/** A fresh repository on one real commit holding `src/a.ts` and `src/c.ts`. */
function makeGitRepo(): string {
  const dir = makeTempDir("nax-hygiene-repo-");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "acceptance@nax.test"]);
  git(dir, ["config", "user.name", "nax acceptance"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeIn(dir, "src/a.ts", "export const a = 1;\n");
  writeIn(dir, "src/c.ts", "export const c = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "baseline"]);
  return dir;
}

function commitAll(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", message]);
}

/**
 * Commit everything, forcing ignored paths in.
 *
 * A `.nax/` fixture must be tracked for AC-35/AC-48 whatever the machine's
 * global `core.excludesFile` says, so the add is forced rather than trusting
 * the developer's ignore rules.
 */
function commitAllForced(repo: string, message: string): void {
  git(repo, ["add", "-A", "-f"]);
  git(repo, ["commit", "-qm", message]);
}

/**
 * Test-pattern config with explicit globs.
 *
 * Explicit on purpose: the production fallback is `test/**\/*.test.ts`, which
 * does not classify `src/foo.test.ts` or `__tests__/foo.ts` — AC-34 names both
 * of those as test files, so the config must say what it means.
 */
const TEST_PATTERN_CONFIG = {
  execution: { smartTestRunner: { testFilePatterns: ["**/*.test.ts", "**/__tests__/**/*.ts"] } },
};

function measureFor(repo: string): (workdir: string, fromRef: string) => Promise<AnyRecord> {
  return createMeasureSourceDiff({
    config: TEST_PATTERN_CONFIG as never,
    projectDir: repo,
    packageDir: repo,
  }) as never;
}

/** The production `listCommitsSince`: the deps seam, or the module's own export. */
function defaultListCommitsSince(): (workdir: string, ref: string) => Promise<string[]> {
  const fromDeps = (_nonBlockingFixDeps as AnyRecord).listCommitsSince;
  if (typeof fromDeps === "function") return fromDeps as never;
  const fromModule = (nonBlockingFixModule as AnyRecord).listCommitsSince;
  if (typeof fromModule === "function") return fromModule as never;
  throw new Error(
    "the default listCommitsSince is unreachable: expected it on `_nonBlockingFixDeps` " +
      "(the repo's injectable-deps convention) or exported from the module",
  );
}

// ─── runNonBlockingFix harness (US-003) ───────────────────────────────────

interface NbfHarness {
  readonly calls: {
    readonly order: string[];
    readonly rollback: unknown[][];
    readonly listCommitsSince: unknown[][];
    readonly reviewFix: unknown[][];
  };
  readonly args: AnyRecord;
  readonly deps: AnyRecord;
}

function nbfHarness(over: {
  workdir?: string;
  measureSourceDiff?: (workdir: string, fromRef: string) => Promise<AnyRecord>;
  listCommitsSince?: (workdir: string, ref: string) => Promise<string[]>;
  withReviewFix?: boolean;
}): NbfHarness {
  const order: string[] = [];
  const rollback: unknown[][] = [];
  const listCommitsSince: unknown[][] = [];
  const reviewFix: unknown[][] = [];
  const workdir = over.workdir ?? "/tmp/nax-hygiene-nbf";

  const args: AnyRecord = {
    workdir,
    storyId: "US-001",
    advisoryFindings: [
      { source: "adversarial-review", severity: "warning", category: "input", message: "advisory warning" },
    ],
    cfg: {
      enabled: true,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      sources: ["adversarial"],
    },
    phaseOutputs: {},
    phaseCosts: {},
    runRectify: async () => ({ rectificationExhausted: false }),
  };

  const measure = over.measureSourceDiff;
  const list = over.listCommitsSince;
  const deps: AnyRecord = {
    captureSnapshotRef: async () => ({ sha: "snap-sha", untrackedBefore: [] }),
    rollbackToRef: async (...call: unknown[]) => {
      order.push("rollbackToRef");
      rollback.push(call);
    },
    measureSourceDiff: async (workdirArg: string, fromRef: string) => {
      order.push("measureSourceDiff");
      return measure === undefined ? { fileCount: 0, sourceLineCount: 0 } : measure(workdirArg, fromRef);
    },
    listCommitsSince: async (workdirArg: string, ref: string) => {
      order.push("listCommitsSince");
      listCommitsSince.push([workdirArg, ref]);
      return list === undefined ? [] : list(workdirArg, ref);
    },
    ...(over.withReviewFix === true
      ? {
          reviewFix: async (...call: unknown[]) => {
            order.push("reviewFix");
            reviewFix.push(call);
            return { kind: "pass", reviewed: true, reason: "ok" };
          },
        }
      : {}),
  };
  return { calls: { order, rollback, listCommitsSince, reviewFix }, args, deps };
}

// ─── launcher helpers (US-004) ────────────────────────────────────────────

const OPEN_POLICY: SandboxPolicy = { writeRoots: [], denyWrite: [], denyRead: [], network: {} };
const AVAILABLE_STATE = { kind: "available", backend: "srt", network: "open" } as const;

interface WrapCapture {
  commands: string[];
}

function fakeBackend(capture: WrapCapture): SandboxBackend {
  return {
    name: "srt",
    async isSupportedPlatform() {
      return true;
    },
    async wrap(req) {
      capture.commands.push(req.command);
      return [req.shell, "-c", req.command];
    },
    annotate() {
      return "";
    },
    commandFinished() {},
    async reset() {},
  };
}

function availableLauncher(capture: WrapCapture = { commands: [] }) {
  return createCommandLauncher({
    state: { ...AVAILABLE_STATE },
    backend: fakeBackend(capture),
    policyFor: async () => OPEN_POLICY,
  });
}

const OK_RESULT = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

function shellRequest(command: string, over: AnyRecord = {}) {
  return {
    spec: { kind: "shell", shell: "/bin/sh", command },
    root: "/tmp",
    cwd: "/tmp",
    timeoutMs: 5_000,
    stripEnvVars: [],
    ...over,
  } as never;
}

/** `BashCheck` / `PolicyVerdict` shapes differ in the criterion wording; accept both. */
function isDenied(result: unknown): boolean {
  const record = result as { kind?: string; deny?: boolean; allowed?: boolean };
  return record.kind === "deny" || record.deny === true || record.allowed === false;
}

function isAllowed(result: unknown): boolean {
  const record = result as { kind?: string; deny?: boolean; allowed?: boolean };
  return record.kind === "allow" || record.deny === false || record.allowed === true;
}

function reasonOf(result: unknown): string {
  const reason = (result as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : "";
}

/** Raw-screen args for a repository root, mirroring `commandBranch`'s own wiring. */
function rawScreenArgs(command: string, root: string, sandboxWrapped?: boolean) {
  return {
    tool: "Bash",
    command,
    initialPath: root,
    root,
    resolvePath: (candidate: string, cwd: string) => resolveWithin(root, resolve(cwd, candidate)),
    ...(sandboxWrapped !== undefined ? { sandboxWrapped } : {}),
  } as never;
}

/**
 * A temp root real-pathed the way `compileToolPolicy` hands it to the screen
 * (`realOrRaw(root)`). On macOS `tmpdir()` is under the `/var` -> `/private/var`
 * symlink, so an unresolved root makes every resolved PRD path look outside it.
 */
function realTempDir(prefix: string): string {
  return realpathSync(makeTempDir(prefix));
}

/** The coding-tool config the US-004 wiring ACs run under: unrestricted, sandbox off. */
function codingSupportConfig(): AnyRecord {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      permissionProfile: "unrestricted",
      permissions: { run: { allow: ["Bash(*)"] } },
      sandbox: { ...DEFAULT_CONFIG.execution.sandbox, enabled: false },
    },
  };
}

// ─── US-001 — spill marker names a reachable path ─────────────────────────

describe("US-001 spill marker names a path the session can open", () => {
  test("AC-1: a Read body over maxBytes ends with the widest marker naming .nax/scratchpad/spill/Read-<callId>.txt", async () => {
    const root = makeTempDir("nax-hygiene-ac1-");
    const callId = "call_00_ac1";
    const maxBytes = 1_000;
    const body = bodyFor(200, 24);
    const originalBytes = Buffer.byteLength(body, "utf8");
    expect(originalBytes).toBeGreaterThan(maxBytes);

    const expectedLine = (delivered: number): string =>
      `... [truncated: full output at .nax/scratchpad/spill/Read-${callId}.txt ` +
      `(open with Read or ScratchpadRead); showing ${delivered} of ${originalBytes} bytes]`;

    // Both the default style and the explicit "root-relative" style must name
    // the same reachable path.
    const withDefault = await applyModelTruncationPolicy(body, { toolName: "Read", callId, root, maxBytes });
    const explicit = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId,
      root,
      maxBytes,
      spillPathStyle: "root-relative",
    });

    for (const content of [withDefault, explicit]) {
      const marker = spillMarker(content);
      // Head direction: the marker IS the last newline-delimited line.
      expect(content.split("\n").at(-1)).toBe(marker.line);
      expect(marker.path).toBe(`.nax/scratchpad/spill/Read-${callId}.txt`);
      expect(marker.reportedOriginalBytes).toBe(originalBytes);
      // N is the UTF-8 byte length of the delivered body portion.
      expect(marker.deliveredBodyBytes).toBe(marker.reportedDeliveredBytes);
      expect(marker.line).toBe(expectedLine(marker.deliveredBodyBytes));
    }
    expect(withDefault.split("\n").at(-1)).toBe(explicit.split("\n").at(-1));
  });

  test("AC-2: a Bash body over maxBytes contains the exact widest marker line naming .nax/scratchpad/spill/Bash-<callId>.txt", async () => {
    const root = makeTempDir("nax-hygiene-ac2-");
    const callId = "call_00_ac2";
    const maxBytes = 1_000;
    const body = bodyFor(200, 24);
    const originalBytes = Buffer.byteLength(body, "utf8");
    expect(originalBytes).toBeGreaterThan(maxBytes);

    const content = await applyModelTruncationPolicy(body, {
      toolName: "Bash",
      callId,
      root,
      maxBytes,
      spillPathStyle: "root-relative",
    });

    const marker = spillMarker(content);
    expect(marker.line).toContain(`.nax/scratchpad/spill/Bash-${callId}.txt (open with Read or ScratchpadRead)`);
    expect(marker.line).toBe(
      `... [truncated: full output at .nax/scratchpad/spill/Bash-${callId}.txt ` +
        `(open with Read or ScratchpadRead); showing ${marker.reportedDeliveredBytes} of ${originalBytes} bytes]`,
    );
    expect(marker.deliveredBodyBytes).toBe(marker.reportedDeliveredBytes);
  });

  test("AC-3: spillPathStyle 'absolute' names the absolute path <root>/.nax/scratchpad/spill/<Tool>-<callId>.txt", async () => {
    const root = makeTempDir("nax-hygiene-ac3-");
    const callId = "call_00_ac3";
    const maxBytes = 1_000;
    const body = bodyFor(200, 24);

    const content = await applyModelTruncationPolicy(body, {
      toolName: "Bash",
      callId,
      root,
      maxBytes,
      spillPathStyle: "absolute",
    });

    const marker = spillMarker(content);
    const expected = join(root, ".nax", "scratchpad", "spill", `Bash-${callId}.txt`);
    expect(marker.line).toContain(`full output at ${expected} (open with Read or ScratchpadRead)`);
    expect(isAbsolute(marker.path)).toBe(true);
    expect(marker.path).toBe(expected);
  });

  test("AC-4: reading join(root, <marker path>) returns the untruncated body", async () => {
    const root = makeTempDir("nax-hygiene-ac4-");
    const callId = "call_00_ac4";
    const maxBytes = 1_500;
    const body = bodyFor(300, 24);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(maxBytes);

    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId,
      root,
      maxBytes,
      spillPathStyle: "root-relative",
    });
    const marker = spillMarker(content);

    const spilled = readFileSync(join(root, marker.path), "utf8");
    expect(spilled).toBe(body);
  });

  test("AC-5: a rejected spill write yields a marker naming no path and no spill reference", async () => {
    const root = makeTempDir("nax-hygiene-ac5-");
    const callId = "call_00_ac5";
    const maxBytes = 1_000;
    const body = bodyFor(200, 24);
    const originalBytes = Buffer.byteLength(body, "utf8");

    const fail = async (): Promise<never> => {
      throw new Error("boom");
    };
    patchDeps(_spillDeps, { mkdir: fail, writeFile: fail });

    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId,
      root,
      maxBytes,
      spillPathStyle: "root-relative",
    });

    const lines = content.split("\n");
    const markerLine = lines.at(-1) as string;
    const delivered = [...lines.slice(0, -1)].join("\n");
    const match = NARROW_MARKER_RE.exec(markerLine);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(Buffer.byteLength(delivered, "utf8"));
    expect(Number(match?.[2])).toBe(originalBytes);
    expect(content).not.toContain("full output at");
    expect(content).not.toContain(".nax/scratchpad/spill/");
    expect(existsSync(join(root, ".nax", "scratchpad", "spill"))).toBe(false);
  });

  test("AC-6: a maxBytes too small for the widest marker keeps the content within maxBytes", async () => {
    const root = makeTempDir("nax-hygiene-ac6-");
    const maxBytes = 60;
    const body = Array.from({ length: 40 }, (_, i) => `line ${i} ${"z".repeat(30)}`).join("\n");
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(maxBytes);

    const content = await applyModelTruncationPolicy(body, {
      toolName: "Read",
      callId: "call_00_ac6",
      root,
      maxBytes,
      spillPathStyle: "root-relative",
    });

    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(content).toContain("truncated");
  });

  test("AC-7: a session in nativeSessionScratchpadRoots gets a root-relative marker whose spill file exists under its workdir", async () => {
    const workdir = makeTempDir("nax-hygiene-ac7-");
    const sessionId = "ac7-session";
    nativeSessionScratchpadRoots.set(sessionId, workdir);

    const body = "x".repeat(MODEL_MAX_BYTES + 500);
    const content = await truncateNativeToolResult(sessionId, body, { toolName: "Read", callId: "call_00_ac7" });

    const marker = spillMarker(content);
    expect(marker.path.startsWith(".nax/scratchpad/spill/")).toBe(true);
    expect(isAbsolute(marker.path)).toBe(false);
    expect(existsSync(join(workdir, marker.path))).toBe(true);
  });

  test("AC-8: a session known only to nativeTranscriptDirs gets an absolute marker under its transcript dir", async () => {
    const transcriptDir = makeTempDir("nax-hygiene-ac8-");
    const sessionId = "ac8-session";
    nativeTranscriptDirs.set(sessionId, transcriptDir);

    const body = "x".repeat(MODEL_MAX_BYTES + 500);
    const content = await truncateNativeToolResult(sessionId, body, { toolName: "Read", callId: "call_00_ac8" });

    const marker = spillMarker(content);
    expect(isAbsolute(marker.path)).toBe(true);
    expect(marker.path.startsWith(transcriptDir + sep)).toBe(true);
    expect(existsSync(marker.path)).toBe(true);
  });

  test("AC-9: ScratchpadRead with '.nax/scratchpad/spill/x.txt' returns the file's content", async () => {
    const root = makeTempDir("nax-hygiene-ac9-");
    const content = "spilled body read through the prefixed path";
    const target = join(root, ".nax", "scratchpad", "spill", "x.txt");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
    expect(readFileSync(target, "utf8")).toBe(content);

    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "ScratchpadRead", patterns: ["*"] }], root),
    });
    runtime.advertised(["ScratchpadRead"]);
    const result = await runtime.callTool("ScratchpadRead", { path: ".nax/scratchpad/spill/x.txt" });

    expect(result.kind).toBe("ok");
    expect(result.content).toContain(content);
    expect(readBody(result.content)).toBe(content);
  });

  test("AC-10: a Bash result over the cap, then Read of the marker's path through the same runtime, contains the last output line", async () => {
    const root = makeTempDir("nax-hygiene-ac10-");
    const lastLine = "LAST-LINE-OF-THE-COMMAND-OUTPUT";
    const stdout = `${"q".repeat(MODEL_MAX_BYTES + 5_000)}\n${lastLine}`;
    const launched: unknown[] = [];
    patchLauncherDeps({
      runArgv: (async (options: unknown) => {
        launched.push(options);
        return { exitCode: 0, stdout, stderr: "", timedOut: false };
      }) as never,
    });

    const support = buildCodingToolSupport({
      root,
      declared: ["Bash", "Read"],
      grants: [
        { tool: "Bash", patterns: ["*"] },
        { tool: "Read", patterns: ["*"] },
      ],
      bashApproval: "raw",
      launcher: createCommandLauncher({ state: DISABLED_SANDBOX_STATE }),
    } as never);
    if (support === undefined) throw new Error("buildCodingToolSupport returned undefined");

    const runtime = support.runtime;
    runtime.advertised(["Bash", "Read"]);

    const bash = await runtime.callTool("Bash", { command: "cat some-file.txt" }, { toolCallId: "ac10-call" });
    expect(bash.kind).toBe("ok");
    expect(launched).toHaveLength(1);

    const marker = spillMarker(bash.content);
    const read = await runtime.callTool("Read", { path: marker.path });
    expect(read.kind).toBe("ok");
    expect(read.content).toContain(lastLine);
  });

  test("AC-11: ScratchpadRead with 'spill/x.txt' still returns the file's content", async () => {
    const root = makeTempDir("nax-hygiene-ac11-");
    const content = "spilled body read through the scratchpad-relative path";
    const target = join(root, ".nax", "scratchpad", "spill", "x.txt");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);

    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "ScratchpadRead", patterns: ["*"] }], root),
    });
    runtime.advertised(["ScratchpadRead"]);
    const result = await runtime.callTool("ScratchpadRead", { path: "spill/x.txt" });

    expect(result.kind).toBe("ok");
    expect(result.content).toContain(content);
    expect(readBody(result.content)).toBe(content);
  });

  test("AC-12: ScratchpadWrite with '.nax/scratchpad/notes.md' writes the repo path once, never a nested copy", async () => {
    const root = makeTempDir("nax-hygiene-ac12-");
    const content = "# notes\n\nacceptance body\n";

    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "ScratchpadWrite", patterns: ["*"] }], root),
    });
    runtime.advertised(["ScratchpadWrite"]);
    const result = await runtime.callTool("ScratchpadWrite", { path: ".nax/scratchpad/notes.md", content });

    expect(result.kind).toBe("ok");
    expect(readFileSync(join(root, ".nax", "scratchpad", "notes.md"), "utf8")).toBe(content);
    expect(existsSync(join(root, ".nax", "scratchpad", ".nax", "scratchpad", "notes.md"))).toBe(false);
  });

  test("AC-13: compileToolPolicy denies ScratchpadRead of '.nax/scratchpad/../config.json'", () => {
    const root = makeTempDir("nax-hygiene-ac13-");
    const policy = compileToolPolicy([{ tool: "ScratchpadRead", patterns: ["*"] }], root);

    const verdict = policy.check("ScratchpadRead", scratchpadReadTool.scope, {
      path: ".nax/scratchpad/../config.json",
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.outcome).not.toBe("ask");
    expect(existsSync(join(root, ".nax", "config.json"))).toBe(false);
  });
});

// ─── US-002 — raw Bash screen ─────────────────────────────────────────────

describe("US-002 raw Bash screen refuses whole-filesystem find and permits sandboxed prd reads", () => {
  test("AC-14: 'find / -name approvals.ts' is a non-escalatable deny naming the repository root", () => {
    const root = makeTempDir("nax-hygiene-ac14-");
    const result = screenRawBashCommand(rawScreenArgs("find / -name approvals.ts", root));

    expect(isDenied(result)).toBe(true);
    expect((result as { escalatable?: boolean }).escalatable).toBe(false);
    expect(reasonOf(result)).toContain(`Search within the repository root instead: ${root}`);
  });

  test("AC-15: 'find ~ -name x' is denied with the whole-filesystem timeout reason", () => {
    const root = makeTempDir("nax-hygiene-ac15-");
    const result = screenRawBashCommand(rawScreenArgs("find ~ -name x", root));

    expect(isDenied(result)).toBe(true);
    expect(reasonOf(result)).toContain(
      `\`find ~\` searches the whole filesystem and runs into the 300s Bash timeout. ` +
        `Search within the repository root instead: ${root}`,
    );
  });

  test("AC-16: 'find $HOME -name x' is denied with the whole-filesystem timeout reason", () => {
    const root = makeTempDir("nax-hygiene-ac16-");
    const result = screenRawBashCommand(rawScreenArgs("find $HOME -name x", root));

    expect(isDenied(result)).toBe(true);
    expect(reasonOf(result)).toContain(
      `\`find $HOME\` searches the whole filesystem and runs into the 300s Bash timeout. ` +
        `Search within the repository root instead: ${root}`,
    );
  });

  test("AC-17: 'find -L / -name x' is denied, naming '/' as the start path", () => {
    const root = makeTempDir("nax-hygiene-ac17-");
    const result = screenRawBashCommand(rawScreenArgs("find -L / -name x", root));

    expect(isDenied(result)).toBe(true);
    expect(reasonOf(result)).toContain("`find /` searches the whole filesystem");
  });

  test("AC-18: 'git status; find / -name x | head' is denied for its second segment", () => {
    const root = makeTempDir("nax-hygiene-ac18-");
    const result = screenRawBashCommand(rawScreenArgs("git status; find / -name x | head", root));

    expect(isDenied(result)).toBe(true);
    expect(reasonOf(result)).toContain("`find /` searches the whole filesystem");
  });

  test("AC-19: 'find /usr/lib -name x' is not refused", () => {
    const root = makeTempDir("nax-hygiene-ac19-");
    const result = screenRawBashCommand(rawScreenArgs("find /usr/lib -name x", root));

    expect(isAllowed(result)).toBe(true);
    expect(reasonOf(result)).not.toContain("whole filesystem");
  });

  test("AC-20: 'find . -name x' is not refused", () => {
    const root = makeTempDir("nax-hygiene-ac20-");
    const result = screenRawBashCommand(rawScreenArgs("find . -name x", root));

    expect(isAllowed(result)).toBe(true);
    expect(reasonOf(result)).not.toContain("whole filesystem");
  });

  test("AC-21: 'find ~/proj -name x' is not refused", () => {
    const root = makeTempDir("nax-hygiene-ac21-");
    const result = screenRawBashCommand(rawScreenArgs("find ~/proj -name x", root));

    expect(isAllowed(result)).toBe(true);
    expect(reasonOf(result)).not.toContain("whole filesystem");
  });

  test("AC-22: 'git diff .nax/features/f/prd.json' is allowed when sandboxWrapped is true", () => {
    const root = realTempDir("nax-hygiene-ac22-");
    const result = screenRawBashCommand(rawScreenArgs("git diff .nax/features/f/prd.json", root, true));

    expect(isAllowed(result)).toBe(true);
    expect(reasonOf(result)).not.toContain("reads included");
  });

  test("AC-23: 'echo x > .nax/features/f/prd.json' is still denied when sandboxWrapped is true", () => {
    const root = realTempDir("nax-hygiene-ac23-");
    const result = screenRawBashCommand(rawScreenArgs("echo x > .nax/features/f/prd.json", root, true));

    expect(isDenied(result)).toBe(true);
    expect(reasonOf(result)).toContain("Reading it through Bash is allowed");
  });

  test("AC-24: 'cat .nax/config.json' is denied when sandboxWrapped is true, with the config wording", () => {
    const root = realTempDir("nax-hygiene-ac24-");
    const result = screenRawBashCommand(rawScreenArgs("cat .nax/config.json", root, true));

    expect(isDenied(result)).toBe(true);
    expect(reasonOf(result)).not.toContain("Reading it through Bash is allowed");
  });

  test("AC-25: without sandboxWrapped, a prd read is denied with the unchanged 'reads included' wording", () => {
    const root = realTempDir("nax-hygiene-ac25-");

    const unset = screenRawBashCommand(rawScreenArgs("git diff .nax/features/f/prd.json", root));
    const explicitFalse = screenRawBashCommand(rawScreenArgs("git diff .nax/features/f/prd.json", root, false));

    for (const result of [unset, explicitFalse]) {
      expect(isDenied(result)).toBe(true);
      expect(reasonOf(result)).toContain("reads included");
    }
  });

  test("AC-26: rawScreenOptionsFor on an available launcher returns { sandboxWrapped: true } and no refusal", () => {
    const launcher = availableLauncher();
    const result = rawScreenOptionsFor(launcher);

    expect(result).toEqual({ sandboxWrapped: true });
    const noRefusalKey = !Object.hasOwn(result, "rawBashRefusal") || result.rawBashRefusal === undefined;
    expect(noRefusalKey).toBe(true);
  });

  test("AC-27: rawScreenOptionsFor on an unavailable launcher carries rawRefusalFor's reason and no sandboxWrapped", () => {
    const launcher = createCommandLauncher({
      state: { kind: "unavailable", backend: "srt", reason: "no backend on this machine" },
    });
    const result = rawScreenOptionsFor(launcher);

    expect(result.rawBashRefusal).toBe(rawRefusalFor(launcher));
    expect(result.rawBashRefusal).toBeTruthy();
    expect(result.sandboxWrapped).not.toBe(true);
  });

  test("AC-28: rawScreenOptionsFor on a disabled launcher returns an empty object", () => {
    const launcher = createCommandLauncher({ state: DISABLED_SANDBOX_STATE });
    const result = rawScreenOptionsFor(launcher);

    expect(Object.keys(result).length).toBe(0);
    expect(result.rawBashRefusal).toBeUndefined();
    expect(result.sandboxWrapped).toBeUndefined();
  });

  test("AC-29: raw mode with an available launcher allows a prd read through the runtime policy", async () => {
    const root = makeTempDir("nax-hygiene-ac29-");
    patchLauncherDeps({ runArgv: (async () => OK_RESULT) as never });

    const support = buildCodingToolSupport({
      root,
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["*"] }],
      bashApproval: "raw",
      launcher: availableLauncher(),
    } as never);
    if (support === undefined) throw new Error("buildCodingToolSupport returned undefined");
    support.runtime.advertised(["Bash"]);

    const result = await support.runtime.callTool("Bash", { command: "git diff .nax/features/f/prd.json" });

    expect(result.kind).not.toBe("denied");
    expect(result.kind).toBe("ok");
  });

  test("AC-30: raw mode with a disabled launcher denies a prd read, naming 'reads included'", async () => {
    const root = makeTempDir("nax-hygiene-ac30-");
    patchLauncherDeps({ runArgv: (async () => OK_RESULT) as never });

    const support = buildCodingToolSupport({
      root,
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["*"] }],
      bashApproval: "raw",
      launcher: createCommandLauncher({ state: DISABLED_SANDBOX_STATE }),
    } as never);
    if (support === undefined) throw new Error("buildCodingToolSupport returned undefined");
    support.runtime.advertised(["Bash"]);

    const result = await support.runtime.callTool("Bash", { command: "git diff .nax/features/f/prd.json" });

    if (result.kind !== "denied") throw new Error(`expected a denied result, got ${result.kind}`);
    expect(result.reason).toContain("reads included");
  });

  test("AC-31: the raw-mode Bash description states that find from /, ~ or $HOME is refused", () => {
    const description = createBashTool({ bashApproval: "raw" }).description;

    // One sentence in the spec, but a refusal clause plus a follow-up advice
    // sentence must also count, so each sentence is judged with its neighbours.
    const sentences = description.split(/(?<=\.)\s+/);
    const clauses = sentences.map((sentence, i) =>
      [sentences[i - 1] ?? "", sentence, sentences[i + 1] ?? ""].join(" "),
    );
    const clause = clauses.find(
      (candidate) =>
        /\bfind\b/.test(candidate) &&
        /refus/i.test(candidate) &&
        /(\/|~|\$HOME)/.test(candidate) &&
        /repositor/i.test(candidate),
    );
    if (clause === undefined) {
      throw new Error(`no find-refusal advice in the raw-mode Bash description: ${description}`);
    }

    expect(/\bfind\b/.test(clause)).toBe(true);
    expect(/refus/i.test(clause)).toBe(true);
    expect(clause).toMatch(/(\/|~|\$HOME)/);
    expect(clause).toMatch(/repositor/i);
  });

  test("AC-32: 'find $(pwd)/.. -name x' is allowed unscreened (refused lex is fail-open)", () => {
    const root = makeTempDir("nax-hygiene-ac32-");
    const result = screenRawBashCommand(rawScreenArgs("find $(pwd)/.. -name x", root));

    expect(isAllowed(result)).toBe(true);
    expect(isDenied(result)).toBe(false);
  });
});

// ─── US-003 — NBF control paths and restore diagnostics ───────────────────

describe("US-003 NBF classifies .nax control paths and records what a restore discarded", () => {
  test("AC-33: createMeasureSourceDiff classifies modified/added/deleted source paths from a real repo", async () => {
    const repo = makeGitRepo();
    const baseline = git(repo, ["rev-parse", "HEAD"]);

    writeIn(repo, "src/a.ts", "export const a = 2;\n");
    writeIn(repo, "src/b.ts", "export const b = 1;\n");
    git(repo, ["add", "src/b.ts"]);
    git(repo, ["rm", "-q", "src/c.ts"]);
    commitAll(repo, "exercise all three statuses");

    const metrics = await measureFor(repo)(repo, baseline);

    expect(metrics.paths).toEqual({
      added: ["src/b.ts"],
      modified: ["src/a.ts"],
      deleted: ["src/c.ts"],
    });
  });

  test("AC-34: a changed test file is excluded from every path list and adds nothing to fileCount", async () => {
    const repo = makeGitRepo();
    const baseline = git(repo, ["rev-parse", "HEAD"]);

    writeIn(repo, "src/foo.test.ts", "// a changed test file\n");
    writeIn(repo, "__tests__/foo.ts", "// another changed test file\n");
    commitAll(repo, "add test files");

    const metrics = await measureFor(repo)(repo, baseline);
    const paths = (metrics.paths ?? { added: [], modified: [], deleted: [] }) as {
      added: string[];
      modified: string[];
      deleted: string[];
    };
    const controlPaths = (metrics.controlPaths ?? []) as string[];

    for (const testPath of ["src/foo.test.ts", "__tests__/foo.ts"]) {
      expect(paths.added).not.toContain(testPath);
      expect(paths.modified).not.toContain(testPath);
      expect(paths.deleted).not.toContain(testPath);
      expect(controlPaths).not.toContain(testPath);
    }
    expect(metrics.fileCount).toBe(0);
  });

  test("AC-35: deleting a tracked .nax story file yields it in controlPaths with zeroed source metrics", async () => {
    const repo = makeGitRepo();
    const storyPath = ".nax/features/f/stories/US-001.json";
    writeIn(repo, storyPath, '{ "id": "US-001" }\n');
    commitAllForced(repo, "track a story file");
    const baseline = git(repo, ["rev-parse", "HEAD"]);

    git(repo, ["rm", "-q", storyPath]);
    commitAll(repo, "delete the story file");

    const metrics = await measureFor(repo)(repo, baseline);

    expect(metrics.controlPaths).toEqual([storyPath]);
    expect(metrics.fileCount).toBe(0);
    expect(metrics.sourceLineCount).toBe(0);
  });

  test("AC-36: a control-path touch inside the cap restores the pass", async () => {
    const harness = nbfHarness({
      measureSourceDiff: async () => ({
        fileCount: 0,
        sourceLineCount: 0,
        controlPaths: [".nax/rules/a.md"],
        paths: { added: [], modified: [], deleted: [] },
      }),
    });

    const result = await runNonBlockingFix(harness.args as never, harness.deps as never);

    expect(result).toMatchObject({ kept: false, restored: true });
    expect(result.ran).toBe(true);
    expect(harness.calls.rollback).toHaveLength(1);
  });

  test("AC-37: the control-path warn names the story, the count and the paths", async () => {
    const harness = nbfHarness({
      measureSourceDiff: async () => ({
        fileCount: 0,
        sourceLineCount: 0,
        controlPaths: [".nax/rules/a.md"],
        paths: { added: [], modified: [], deleted: [] },
      }),
    });

    await withLogSpies(async ({ warn }) => {
      await runNonBlockingFix(harness.args as never, harness.deps as never);
      const call = firstCallWithMessage(warn, "NBF pass touched nax control files — restoring");
      expect(call).toBeDefined();
      expect(call?.[0]).toBe("non-blocking-fix");
      const data = (call?.[2] ?? {}) as AnyRecord;
      expect(data.storyId).toBe("US-001");
      expect(data.controlPathCount).toBe(1);
      expect(data.controlPaths).toEqual([".nax/rules/a.md"]);
    });
  });

  test("AC-38: 25 control paths log 20 entries beside a count of 25", async () => {
    const controlPaths = Array.from({ length: 25 }, (_, i) => `.nax/rules/rule-${i}.md`);
    const harness = nbfHarness({
      measureSourceDiff: async () => ({
        fileCount: 0,
        sourceLineCount: 0,
        controlPaths,
        paths: { added: [], modified: [], deleted: [] },
      }),
    });

    await withLogSpies(async ({ warn }) => {
      await runNonBlockingFix(harness.args as never, harness.deps as never);
      const call = firstCallWithMessage(warn, "NBF pass touched nax control files — restoring");
      expect(call).toBeDefined();
      const data = (call?.[2] ?? {}) as AnyRecord;
      expect(data.controlPathCount).toBe(25);
      expect(data.controlPaths).toEqual(controlPaths.slice(0, 20));
    });
  });

  test("AC-39: the cap log carries every path list and its count", async () => {
    const harness = nbfHarness({
      measureSourceDiff: async () => ({
        fileCount: 99,
        sourceLineCount: 9_999,
        paths: { added: ["a.ts"], modified: ["m.ts"], deleted: ["d.ts"] },
        controlPaths: [],
      }),
    });

    await withLogSpies(async ({ info }) => {
      await runNonBlockingFix(harness.args as never, harness.deps as never);
      const call = firstCallWithMessage(info, "source diff exceeded cap — restoring");
      expect(call).toBeDefined();
      const data = (call?.[2] ?? {}) as AnyRecord;
      expect(data.added).toEqual(["a.ts"]);
      expect(data.modified).toEqual(["m.ts"]);
      expect(data.deleted).toEqual(["d.ts"]);
      expect(data.addedCount).toBe(1);
      expect(data.modifiedCount).toBe(1);
      expect(data.deletedCount).toBe(1);
    });
  });

  test("AC-40: 30 added paths log 20 entries beside an addedCount of 30", async () => {
    const added = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`);
    const harness = nbfHarness({
      measureSourceDiff: async () => ({
        fileCount: 30,
        sourceLineCount: 9_999,
        paths: { added, modified: [], deleted: [] },
        controlPaths: [],
      }),
    });

    await withLogSpies(async ({ info }) => {
      await runNonBlockingFix(harness.args as never, harness.deps as never);
      const call = firstCallWithMessage(info, "source diff exceeded cap — restoring");
      expect(call).toBeDefined();
      const data = (call?.[2] ?? {}) as AnyRecord;
      expect((data.added as string[]).length).toBe(20);
      expect(data.added).toEqual(added.slice(0, 20));
      expect(data.addedCount).toBe(30);
    });
  });

  test("AC-41: a within-cap pass with no paths and no control paths is kept", async () => {
    const harness = nbfHarness({
      measureSourceDiff: async () => ({ fileCount: 1, sourceLineCount: 10 }),
    });

    const result = await runNonBlockingFix(harness.args as never, harness.deps as never);

    expect(result.kept).toBe(true);
    expect(result.restored).toBe(false);
    expect(harness.calls.rollback).toHaveLength(0);
  });

  test("AC-42: a restore asks listCommitsSince for the workdir and the snapshot sha before rolling back", async () => {
    const workdir = "/tmp/nax-hygiene-nbf-ac42";
    const harness = nbfHarness({
      workdir,
      measureSourceDiff: async () => ({
        fileCount: 0,
        sourceLineCount: 0,
        controlPaths: [".nax/rules/a.md"],
        paths: { added: [], modified: [], deleted: [] },
      }),
    });

    await runNonBlockingFix(harness.args as never, harness.deps as never);

    expect(harness.calls.listCommitsSince).toHaveLength(1);
    expect(harness.calls.listCommitsSince[0]).toEqual([workdir, "snap-sha"]);
    expect(harness.calls.rollback).toHaveLength(1);
    const listIndex = harness.calls.order.indexOf("listCommitsSince");
    const rollbackIndex = harness.calls.order.indexOf("rollbackToRef");
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(rollbackIndex).toBeGreaterThan(listIndex);
  });

  test("AC-43: the exhausted log carries the discarded commits listCommitsSince resolved", async () => {
    const harness = nbfHarness({
      measureSourceDiff: async () => ({
        fileCount: 0,
        sourceLineCount: 0,
        controlPaths: [".nax/rules/a.md"],
        paths: { added: [], modified: [], deleted: [] },
      }),
      listCommitsSince: async () => ["sha2", "sha1"],
    });

    await withLogSpies(async ({ info }) => {
      await runNonBlockingFix(harness.args as never, harness.deps as never);
      const call = firstCallWithMessage(info, "best-effort fix exhausted — restored to adversarial-passed");
      expect(call).toBeDefined();
      expect((call?.[2] ?? {}) as AnyRecord).toMatchObject({ discardedCommits: ["sha2", "sha1"] });
    });
  });

  test("AC-44: a rejecting listCommitsSince still rolls back and logs an empty discarded list", async () => {
    const harness = nbfHarness({
      measureSourceDiff: async () => ({
        fileCount: 0,
        sourceLineCount: 0,
        controlPaths: [".nax/rules/a.md"],
        paths: { added: [], modified: [], deleted: [] },
      }),
      listCommitsSince: async () => {
        throw new Error("git rev-list failed");
      },
    });

    await withLogSpies(async ({ info, warn }) => {
      const result = await runNonBlockingFix(harness.args as never, harness.deps as never);

      expect(harness.calls.rollback).toHaveLength(1);
      expect(result.restored).toBe(true);
      const call = firstCallWithMessage(info, "best-effort fix exhausted — restored to adversarial-passed");
      expect(call).toBeDefined();
      expect((call?.[2] ?? {}) as AnyRecord).toMatchObject({ discardedCommits: [] });
      expect(spyCalls(warn).length + spyCalls(info).length).toBeGreaterThan(0);
    });
  });

  test("AC-45: a kept pass never asks listCommitsSince", async () => {
    const harness = nbfHarness({
      measureSourceDiff: async () => ({
        fileCount: 1,
        sourceLineCount: 10,
        controlPaths: [],
        paths: { added: [], modified: [], deleted: [] },
      }),
    });

    const result = await runNonBlockingFix(harness.args as never, harness.deps as never);

    expect(result.kept).toBe(true);
    expect(harness.calls.listCommitsSince).toHaveLength(0);
  });

  test("AC-46: the default listCommitsSince returns the commits after the ref, newest first", async () => {
    const repo = makeGitRepo();
    const baseline = git(repo, ["rev-parse", "HEAD"]);

    writeIn(repo, "src/one.ts", "export const one = 1;\n");
    commitAll(repo, "first commit after the ref");
    const first = git(repo, ["rev-parse", "HEAD"]);

    writeIn(repo, "src/two.ts", "export const two = 1;\n");
    commitAll(repo, "second commit after the ref");
    const second = git(repo, ["rev-parse", "HEAD"]);

    const listCommitsSince = defaultListCommitsSince();
    const shas = await listCommitsSince(repo, baseline);

    expect(shas).toEqual([second, first]);
  });

  test("AC-47: a rejecting measureSourceDiff warns and restores exactly once", async () => {
    const harness = nbfHarness({
      measureSourceDiff: async () => {
        throw new Error("git diff failed");
      },
    });

    await withLogSpies(async ({ warn }) => {
      const result = await runNonBlockingFix(harness.args as never, harness.deps as never);

      expect(result.restored).toBe(true);
      expect(harness.calls.rollback).toHaveLength(1);
      const failure = spyCalls(warn).find((args) => /measure/i.test(String(args[1])));
      expect(failure).toBeDefined();
      expect(failure?.[0]).toBe("non-blocking-fix");
    });
  });

  test("AC-48: a changed acceptance test under .nax is a control path, not an excluded test file", async () => {
    const repo = makeGitRepo();
    const acceptancePath = ".nax/features/f/.nax-acceptance.test.ts";
    writeIn(repo, acceptancePath, 'test("first", () => {});\n');
    commitAllForced(repo, "track the acceptance test");
    const baseline = git(repo, ["rev-parse", "HEAD"]);

    writeIn(repo, acceptancePath, 'test("second", () => {});\n');
    commitAll(repo, "change the acceptance test");

    const metrics = await measureFor(repo)(repo, baseline);

    expect(metrics.controlPaths).toEqual([acceptancePath]);
    expect(metrics.fileCount).toBe(0);
  });

  test("AC-49: a control-path restore never reaches the fix review", async () => {
    const harness = nbfHarness({
      withReviewFix: true,
      measureSourceDiff: async () => ({
        fileCount: 0,
        sourceLineCount: 0,
        controlPaths: [".nax/rules/a.md"],
        paths: { added: [], modified: [], deleted: [] },
      }),
    });

    const result = await runNonBlockingFix(harness.args as never, harness.deps as never);

    expect(result.restored).toBe(true);
    expect(harness.calls.reviewFix).toHaveLength(0);
  });
});

// ─── US-004 — per-session TMPDIR ──────────────────────────────────────────

function makePluginRegistryStub() {
  return {
    getReporters: () => [],
    getPostRunActionRegistrations: () => [],
    teardownAll: async () => {},
  };
}

function cleanupOptions(over: AnyRecord = {}): AnyRecord {
  const workdir = makeTempDir("nax-hygiene-cleanup-");
  return {
    runId: "r1",
    startTime: Date.now() - 5,
    totalCost: 0,
    storiesCompleted: 0,
    prd: { project: "nax", feature: "agent-hygiene", userStories: [] },
    pluginRegistry: makePluginRegistryStub(),
    workdir,
    interactionChain: null,
    feature: "agent-hygiene",
    prdPath: join(workdir, "prd.json"),
    branch: "feat/agent-hygiene",
    version: "0.0.0",
    hooks: { hooks: {} },
    dryRun: false,
    ...over,
  };
}

/** Stub the cleanup seams a run-temp-dir criterion does not care about. */
function stubCleanupDeps(wipeCalls: string[]): void {
  patchDeps(_runCleanupDeps, {
    wipeScratchpad: async () => {},
    resetSandbox: async () => {},
    releaseLock: async () => {},
    releaseFeatureLock: async () => {},
    wipeRunTmp: async (runId: string) => {
      wipeCalls.push(runId);
    },
  });
}

describe("US-004 per-session TMPDIR under /tmp/nax-<runId>/", () => {
  test("AC-50: sessionTmpDir('run-1', 'US-001-implementer') is '/tmp/nax-run-1/US-001-implementer'", () => {
    expect(sessionTmpDir("run-1", "US-001-implementer")).toBe("/tmp/nax-run-1/US-001-implementer");
  });

  test("AC-51: sessionTmpDir('run-1', 'a/b') replaces the slash with an underscore", () => {
    const result = sessionTmpDir("run-1", "a/b");
    expect(result).toBe("/tmp/nax-run-1/a_b");
    expect(result).not.toContain("a/b");
  });

  test("AC-52: runTmpRoot('run-1') is '/tmp/nax-run-1'", () => {
    expect(runTmpRoot("run-1")).toBe("/tmp/nax-run-1");
  });

  test("AC-53: a disabled launcher with tmpDir exports TMPDIR, TMP and TEMP to runArgv", async () => {
    const tmpDir = "/tmp/nax-test/session";
    const calls: AnyRecord[] = [];
    patchLauncherDeps({
      runArgv: (async (options: unknown) => {
        calls.push(options as AnyRecord);
        return OK_RESULT;
      }) as never,
    });

    const launcher = createCommandLauncher({ state: DISABLED_SANDBOX_STATE, tmpDir });
    await launcher.run(shellRequest("echo hi"));

    expect(calls).toHaveLength(1);
    const env = calls[0]?.env as Record<string, string> | undefined;
    expect(env?.TMPDIR).toBe(tmpDir);
    expect(env?.TMP).toBe(tmpDir);
    expect(env?.TEMP).toBe(tmpDir);
  });

  test("AC-54: a request env value wins over the TMPDIR overlay", async () => {
    const tmpDir = "/tmp/nax-test/session";
    const calls: AnyRecord[] = [];
    patchLauncherDeps({
      runArgv: (async (options: unknown) => {
        calls.push(options as AnyRecord);
        return OK_RESULT;
      }) as never,
    });

    const launcher = createCommandLauncher({ state: DISABLED_SANDBOX_STATE, tmpDir });
    await launcher.run(shellRequest("echo hi", { env: { TMPDIR: "/custom/tmp" } }));

    const env = calls[0]?.env as Record<string, string> | undefined;
    expect(env?.TMPDIR).toBe("/custom/tmp");
    expect(env?.TMP).toBe(tmpDir);
    expect(env?.TEMP).toBe(tmpDir);
  });

  test("AC-55: an available launcher prefixes the wrapped command with the TMPDIR exports", async () => {
    const tmpDir = "/tmp/nax-test/session";
    const capture: WrapCapture = { commands: [] };
    patchLauncherDeps({ runArgv: (async () => OK_RESULT) as never });

    const launcher = createCommandLauncher({
      state: { ...AVAILABLE_STATE },
      backend: fakeBackend(capture),
      policyFor: async () => OPEN_POLICY,
      tmpDir,
    });
    await launcher.run(shellRequest("echo hi"));

    expect(capture.commands).toHaveLength(1);
    expect(capture.commands[0]).toBe(`export TMPDIR='${tmpDir}' TMP='${tmpDir}' TEMP='${tmpDir}'; echo hi`);
  });

  test("AC-56: the wrapped launcher's executed argv stays the unprefixed command", async () => {
    const tmpDir = "/tmp/nax-test/session";
    const capture: WrapCapture = { commands: [] };
    patchLauncherDeps({ runArgv: (async () => OK_RESULT) as never });

    const launcher = createCommandLauncher({
      state: { ...AVAILABLE_STATE },
      backend: fakeBackend(capture),
      policyFor: async () => OPEN_POLICY,
      tmpDir,
    });
    const result = await launcher.run(shellRequest("echo hi"));

    expect(result.executed).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(result.executed.join(" ")).not.toContain("TMPDIR");
  });

  test("AC-57: tmpDir exists recursively before runArgv and before backend.wrap", async () => {
    const tmpDir = "/tmp/nax-test/session";
    rmSync("/tmp/nax-test", { recursive: true, force: true });

    let existedAtRun: boolean | undefined;
    patchLauncherDeps({
      runArgv: (async () => {
        existedAtRun = existsSync(tmpDir);
        return OK_RESULT;
      }) as never,
    });

    await createCommandLauncher({ state: DISABLED_SANDBOX_STATE, tmpDir }).run(shellRequest("echo hi"));
    expect(existedAtRun).toBe(true);
    expect(existsSync(tmpDir)).toBe(true);

    // Recursive creation is what makes the nested path exist at all.
    rmSync("/tmp/nax-test", { recursive: true, force: true });
    let existedAtWrap: boolean | undefined;
    const backend: SandboxBackend = {
      name: "srt",
      async isSupportedPlatform() {
        return true;
      },
      async wrap(req) {
        existedAtWrap = existsSync(tmpDir);
        return [req.shell, "-c", req.command];
      },
      annotate() {
        return "";
      },
      commandFinished() {},
      async reset() {},
    };
    await createCommandLauncher({
      state: { ...AVAILABLE_STATE },
      backend,
      policyFor: async () => OPEN_POLICY,
      tmpDir,
    }).run(shellRequest("echo hi"));

    expect(existedAtWrap).toBe(true);
  });

  test("AC-58: an uncreatable tmpDir runs without the override and warns", async () => {
    const blocker = makeTempDir("nax-hygiene-ac58-");
    const blockerFile = join(blocker, "not-a-directory");
    writeFileSync(blockerFile, "this is a file\n");
    const tmpDir = join(blockerFile, "session");

    const calls: AnyRecord[] = [];
    patchLauncherDeps({
      runArgv: (async (options: unknown) => {
        calls.push(options as AnyRecord);
        return OK_RESULT;
      }) as never,
    });

    await withLogSpies(async ({ warn }) => {
      const result = await createCommandLauncher({ state: DISABLED_SANDBOX_STATE, tmpDir }).run(
        shellRequest("echo hi"),
      );

      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      const env = (calls[0]?.env ?? {}) as Record<string, string>;
      expect(env.TMPDIR).toBeUndefined();
      expect(env.TMP).toBeUndefined();
      expect(env.TEMP).toBeUndefined();

      const call = firstCallWithMessage(warn, "could not create session temp dir — running without TMPDIR override");
      expect(call).toBeDefined();
      expect(call?.[0]).toBe("sandbox");
      const data = (call?.[2] ?? {}) as AnyRecord;
      expect(data.tmpDir).toBe(tmpDir);
      expect(data.error).toBeTruthy();
    });
  });

  test("AC-59: a launcher without tmpDir passes no env when the request sets none", async () => {
    const calls: AnyRecord[] = [];
    patchLauncherDeps({
      runArgv: (async (options: unknown) => {
        calls.push(options as AnyRecord);
        return OK_RESULT;
      }) as never,
    });

    await createCommandLauncher({ state: DISABLED_SANDBOX_STATE }).run(shellRequest("echo hi"));

    expect(calls).toHaveLength(1);
    const passedEnv = !Object.hasOwn(calls[0] as object, "env") || calls[0]?.env === undefined;
    expect(passedEnv).toBe(true);
  });

  test("AC-60: resolveSessionSandbox forwards tmpDir to a disabled launcher", async () => {
    const tmpDir = "/tmp/nax-r1/session";
    const calls: AnyRecord[] = [];
    patchLauncherDeps({
      runArgv: (async (options: unknown) => {
        calls.push(options as AnyRecord);
        return OK_RESULT;
      }) as never,
    });

    const launcher = await resolveSessionSandbox({
      config: { ...DEFAULT_CONFIG.execution.sandbox, enabled: false },
      root: makeTempDir("nax-hygiene-ac60-"),
      needsLauncher: true,
      tmpDir,
    } as never);

    await launcher.run(shellRequest("echo hi"));

    const env = calls[0]?.env as Record<string, string> | undefined;
    expect(env?.TMPDIR).toBe(tmpDir);
  });

  test("AC-61: resolveCodingToolSupport with a runId gives Bash the session temp dir", async () => {
    const root = makeTempDir("nax-hygiene-ac61-");
    const calls: AnyRecord[] = [];
    patchLauncherDeps({
      runArgv: (async (options: unknown) => {
        calls.push(options as AnyRecord);
        return OK_RESULT;
      }) as never,
    });

    const support = await resolveCodingToolSupport({
      declaredTools: ["Bash"],
      codingToolRoot: root,
      config: codingSupportConfig(),
      pipelineStage: "run",
      runId: "r1",
      storyId: "US-001",
      sessionRole: "implementer",
    } as never);
    if (support === undefined) throw new Error("resolveCodingToolSupport returned undefined");
    support.runtime.advertised(["Bash"]);

    const result = await support.runtime.callTool("Bash", { command: "true" });

    expect(result.kind).toBe("ok");
    expect(buildLedgerSessionName({ storyId: "US-001", sessionRole: "implementer" })).toBe("US-001-implementer");
    const env = calls[0]?.env as Record<string, string> | undefined;
    expect(env?.TMPDIR).toBe("/tmp/nax-r1/US-001-implementer");
  });

  test("AC-62: resolveCodingToolSupport without a runId sets no TMPDIR", async () => {
    const root = makeTempDir("nax-hygiene-ac62-");
    const calls: AnyRecord[] = [];
    patchLauncherDeps({
      runArgv: (async (options: unknown) => {
        calls.push(options as AnyRecord);
        return OK_RESULT;
      }) as never,
    });

    const support = await resolveCodingToolSupport({
      declaredTools: ["Bash"],
      codingToolRoot: root,
      config: codingSupportConfig(),
      pipelineStage: "run",
      storyId: "US-001",
      sessionRole: "implementer",
    } as never);
    if (support === undefined) throw new Error("resolveCodingToolSupport returned undefined");
    support.runtime.advertised(["Bash"]);

    const result = await support.runtime.callTool("Bash", { command: "true" });

    expect(result.kind).toBe("ok");
    const env = (calls[0]?.env ?? {}) as Record<string, string>;
    expect(env.TMPDIR).toBeUndefined();
  });

  test('AC-63: a disabled launcher runs `echo "$TMPDIR"` with the per-session dir', async () => {
    const tmpDir = makeTempDir("nax-hygiene-ac63-");
    const launcher = createCommandLauncher({ state: DISABLED_SANDBOX_STATE, tmpDir });

    const result = await launcher.run(shellRequest('echo "$TMPDIR"'));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(tmpDir);
  });

  test("AC-64: wipeRunTmp('r1') removes the run's own root once", async () => {
    const { wipeRunTmp, deps } = await loadRunTmpWipe();
    const calls: string[] = [];
    patchDeps(deps, {
      remove: async (path: string) => {
        calls.push(path);
      },
      // The #2300 guard reads this before removing, and the real one answers
      // "absent" for whatever `/tmp/nax/r1` is on this host at this moment.
      exists: () => true,
    });
    // US-001 moved the root under the shared `/tmp/nax` parent, so the removal
    // path is only `/tmp/nax/r1` when that parent resolves to the shared one.
    // Pin it: an absent `/tmp/nax` is the documented usable case (the launcher
    // creates it), which makes the expected path host-independent.
    patchDeps(sandboxModule._sessionTmpDeps as AnyRecord, {
      lstat: () => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      },
      uid: () => 501,
    });

    await wipeRunTmp("r1");

    expect(calls).toEqual(["/tmp/nax/r1"]);
  });

  test("AC-65: wipeRunTmp resolves and warns when removal rejects", async () => {
    const { wipeRunTmp, deps } = await loadRunTmpWipe();
    patchDeps(deps, {
      remove: async () => {
        throw new Error("boom");
      },
      // Same as AC-64: the rejection is the subject, so the guard must not
      // short-circuit ahead of it.
      exists: () => true,
    });

    await withLogSpies(async ({ warn }) => {
      await expect(wipeRunTmp("r1")).resolves.toBeUndefined();
      expect(spyCalls(warn).length).toBeGreaterThan(0);
    });
  });

  test("AC-66: cleanupRun on an incomplete run wipes the run's temp root", async () => {
    const wipeCalls: string[] = [];
    stubCleanupDeps(wipeCalls);

    // #2300: the wipe is handed `runtimeRunId`, never the runner's `runId` —
    // only that id addresses the tree `runTmpRoot` created.
    await cleanupRun(
      cleanupOptions({ runId: "r1", runtimeRunId: "r1", runCompleted: false, dryRun: undefined }) as never,
    );

    expect(wipeCalls).toEqual(["r1"]);
  });

  test("AC-67: cleanupRun under dryRun never wipes the run's temp root", async () => {
    const wipeCalls: string[] = [];
    stubCleanupDeps(wipeCalls);

    await cleanupRun(cleanupOptions({ runId: "r1", dryRun: true }) as never);

    expect(wipeCalls).toEqual([]);
  });

  test("AC-68: buildScratchpadSection tells the agent to use $TMPDIR rather than /tmp", () => {
    const section = buildScratchpadSection();

    expect(section).toContain("Put temporary files there (`$TMPDIR` or `mktemp`), not in `/tmp` directly.");
  });
});

// ─── US-005 — shadow tmpWrite signal ──────────────────────────────────────

/** A shadow that appends its rows to the real JSONL file the production wiring writes. */
function shadowWritingTo(dir: string, runId: string) {
  return createCommandShadow({
    classify: async () => ({ status: "unavailable", error: "acceptance" }) as never,
    write: (row) => appendCommandSafetyRow(dir, runId, row),
    runId,
    timeoutMs: 1_000,
  });
}

function shadowObservation(command: string) {
  return {
    command,
    identity: "Bash" as const,
    stage: "run",
    storyId: "US-001",
    mechanical: { verdict: "allow" as const, breach: false },
  };
}

function jsonlRows(dir: string, runId: string): AnyRecord[] {
  const path = join(dir, `${runId}.jsonl`);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (text === "") return [];
  return text.split("\n").map((line) => JSON.parse(line) as AnyRecord);
}

describe("US-005 the command-safety shadow records literal /tmp writes", () => {
  test("AC-69: detectTmpWrite('echo x > /tmp/a.txt') is true", async () => {
    const detectTmpWrite = await loadDetectTmpWrite();
    expect(detectTmpWrite("echo x > /tmp/a.txt")).toBe(true);
  });

  test("AC-70: detectTmpWrite sees the write in a refused-lex heredoc command", async () => {
    const detectTmpWrite = await loadDetectTmpWrite();
    expect(detectTmpWrite("cd /tmp && cat > tsconfig.json <<'EOF'\n{}\nEOF")).toBe(true);
  });

  test("AC-71: detectTmpWrite('tee /tmp/out.log') is true", async () => {
    const detectTmpWrite = await loadDetectTmpWrite();
    expect(detectTmpWrite("tee /tmp/out.log")).toBe(true);
  });

  test("AC-72: detectTmpWrite('cp src/a.ts /private/tmp/') is true", async () => {
    const detectTmpWrite = await loadDetectTmpWrite();
    expect(detectTmpWrite("cp src/a.ts /private/tmp/")).toBe(true);
  });

  test("AC-73: detectTmpWrite('mkdir -p /tmp/probe') is true", async () => {
    const detectTmpWrite = await loadDetectTmpWrite();
    expect(detectTmpWrite("mkdir -p /tmp/probe")).toBe(true);
  });

  test("AC-74: detectTmpWrite('cat /tmp/a.txt') is false", async () => {
    const detectTmpWrite = await loadDetectTmpWrite();
    expect(detectTmpWrite("cat /tmp/a.txt")).toBe(false);
  });

  test("AC-75: detectTmpWrite ignores nax's own /tmp/nax-* directories", async () => {
    const detectTmpWrite = await loadDetectTmpWrite();
    expect(detectTmpWrite("echo x > /tmp/nax-r1/US-001-implementer/a.txt")).toBe(false);
  });

  test("AC-76: a relative write resolved under cwd /tmp counts as a tmp write", async () => {
    const detectTmpWrite = await loadDetectTmpWrite();
    expect(detectTmpWrite("echo x > out.txt", "/tmp")).toBe(true);
  });

  test("AC-77: the same relative write under a repository cwd does not count", async () => {
    const detectTmpWrite = await loadDetectTmpWrite();
    expect(detectTmpWrite("echo x > out.txt", "/repo")).toBe(false);
  });

  test("AC-78: an opaque ($-expanded) target is not counted", async () => {
    const detectTmpWrite = await loadDetectTmpWrite();
    expect(detectTmpWrite('echo x > "$TMPDIR/a"')).toBe(false);
  });

  test("AC-79: an observed `cd /tmp && echo x > a.txt` row records signals.tmpWrite true", async () => {
    const dir = makeTempDir("nax-hygiene-ac79-");
    const shadow = shadowWritingTo(dir, "run-ac79");

    shadow.observe("ac79", shadowObservation("cd /tmp && echo x > a.txt"));
    shadow.settle("ac79", { ledger: "ok" });
    await shadow.drain();

    const rows = jsonlRows(dir, "run-ac79");
    expect(rows).toHaveLength(1);
    const signals = rows[0]?.signals as { tmpWrite?: boolean } | undefined;
    expect(signals?.tmpWrite).toBe(true);
  });

  test("AC-80: an observed `ls` row records signals.tmpWrite false and the current rule-set version", async () => {
    const dir = makeTempDir("nax-hygiene-ac80-");
    const shadow = shadowWritingTo(dir, "run-ac80");

    shadow.observe("ac80", shadowObservation("ls"));
    shadow.settle("ac80", { ledger: "ok" });
    await shadow.drain();

    const rows = jsonlRows(dir, "run-ac80");
    expect(rows).toHaveLength(1);
    const signals = rows[0]?.signals as { tmpWrite?: boolean } | undefined;
    expect(signals?.tmpWrite).toBe(false);
    expect((rows[0]?.rules as { version?: number } | undefined)?.version).toBe(RULE_SET_VERSION);
  });

  test("AC-81: detectTmpWrite on a refused-lex fixture does not throw and reads the lexable prefix", async () => {
    const detectTmpWrite = await loadDetectTmpWrite();
    const fixture = "cd /tmp && cat > f <<'EOF'";
    let result: boolean | undefined;
    expect(() => {
      result = detectTmpWrite(fixture);
    }).not.toThrow();
    expect(result).toBe(true);
  });

  test("AC-82: a refused-lex command observed through the shadow writes signals.tmpWrite true", async () => {
    const dir = makeTempDir("nax-hygiene-ac82-");
    const shadow = shadowWritingTo(dir, "run-ac82");
    const fixture = "cd /tmp && cat > f <<'EOF'";

    expect(() => shadow.observe("ac82", shadowObservation(fixture))).not.toThrow();
    shadow.settle("ac82", { ledger: "ok" });
    await shadow.drain();

    const rows = jsonlRows(dir, "run-ac82");
    expect(rows).toHaveLength(1);
    const signals = rows[0]?.signals as { tmpWrite?: boolean } | undefined;
    expect(signals?.tmpWrite).toBe(true);
  });
});