import { expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { realpath as realpathAsync, stat as statAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NaxError } from "@/errors";
import { rejectGlobalOnlyKeys } from "@/config";
import type { NaxConfig } from "@/config";
import { SandboxConfigSchema } from "@/config/schemas-sandbox";
import { realOrRaw } from "@/utils/realpath";
import { loadPlugins } from "@/plugins/loader";
import { _pluginLoaderDeps, loadPluginProviders } from "@/context/engine/providers/plugin-loader";
import { fireHook, type HookContext, type LoadedHooksConfig } from "@/hooks";
import { _mcpClientDeps } from "@/mcp/client";
import { createMcpPool } from "@/mcp/pool";
import { _qualityRunnerDeps, runQualityCommand } from "@/quality/runner";
import { _executorDeps, executeWithTimeout } from "@/verification";
import { _hardeningDeps, runHardeningPass, type HardeningContext } from "@/acceptance/hardening";
import {
  _newPackageSetupDeps,
  markNewPackageDirs,
  maybeRunNewPackageSetup,
} from "@/execution/new-package-setup";
import { _worktreeDependencyDeps, prepareWorktreeDependencies } from "@/worktree/dependencies";
import { _sessionSandboxDeps, resolveSessionSandbox } from "@/agents/coding-tool-sandbox";
import { buildSandboxPolicy } from "@/sandbox";

/**
 * Inline SandboxBackend double (same shape as test/helpers/sandbox.ts). Kept
 * local so this file only relies on the `@/*` alias that feature-directory
 * tests already resolve. `wrap` records every request so a test can assert on
 * the policy the launcher handed to the backend.
 */
function makeRecordingFakeBackend(): {
  name: "srt";
  calls: Array<{ command: string; shell: string; policy: { denyWrite: readonly string[] }; cwd: string; commandId: string }>;
  isSupportedPlatform: () => Promise<boolean>;
  wrap: (req: {
    command: string;
    shell: string;
    policy: { denyWrite: readonly string[] };
    cwd: string;
    commandId: string;
  }) => Promise<readonly string[]>;
  annotate: () => string;
  commandFinished: () => void;
  reset: () => Promise<void>;
} {
  const calls: Array<{
    command: string;
    shell: string;
    policy: { denyWrite: readonly string[] };
    cwd: string;
    commandId: string;
  }> = [];
  return {
    name: "srt",
    calls,
    async isSupportedPlatform() {
      return true;
    },
    async wrap(req) {
      calls.push(req);
      return [req.shell, "-c", req.command];
    },
    annotate() {
      return "";
    },
    commandFinished() {},
    async reset() {},
  };
}

// ─── Module shapes (structural: the trust modules are imported dynamically) ────

type TrustEntry = { path: string; addedAt: string; via: "prompt" | "cli" };
type StoreRead =
  | { state: "missing" }
  | { state: "ok"; file: { version: number; folders: TrustEntry[] } }
  | { state: "unparseable"; reason: string };

interface TrustApi {
  resolveTrustRoot(workdir: string): string;
  normalizeTrustPath(path: string): Promise<string>;
  findCoveringEntry(folders: readonly TrustEntry[], normalizedPath: string): TrustEntry | null;
  trustStorePath(): string;
  readTrustStore(): Promise<StoreRead>;
  addTrustEntry(path: string, via: "prompt" | "cli"): Promise<unknown>;
  removeTrustEntry(path: string): Promise<unknown>;
  _trustStoreDeps: { now: () => Date };
  markTrusted(normalizedRoot: string): void;
  assertTrusted(path: string, surface: string): Promise<void>;
  resetTrustRegistry(): void;
  _trustPromptDeps: { ask: (question: string) => Promise<string | null> };
  promptTrustChoice(root: string, parent: string | null): Promise<"yes" | "parent" | "no">;
  _trustGateDeps: {
    prompt: (root: string, parent: string | null) => Promise<"yes" | "parent" | "no">;
    homedir: () => string;
  };
  ensureProjectTrusted(root: string, options: { interactive: boolean }): Promise<void>;
}

interface TrustGateCliApi {
  runTrustGate(workdir: string): Promise<void>;
  _trustGateCliDeps: {
    isInteractive: () => boolean;
    error: (text: string) => void;
    exit: (code: number) => never;
  };
}

interface CliTrustApi {
  _cliTrustDeps: {
    log: (text: string) => void;
    error: (text: string) => void;
    isTTY: () => boolean;
    confirm: (question: string) => Promise<boolean>;
    homedir: () => string;
    cwd: () => string;
  };
  trustListCommand(options: { json?: boolean }): Promise<number>;
  trustAddCommand(options: { path?: string; yes?: boolean; force?: boolean }): Promise<number>;
  trustRmCommand(options: { path: string }): Promise<number>;
  trustCheckCommand(options: { path?: string; json?: boolean }): Promise<number>;
}

async function trustApi(): Promise<TrustApi> {
  return (await import("@/trust")) as TrustApi;
}
async function trustGateCliApi(): Promise<TrustGateCliApi> {
  return (await import("@/cli/trust-gate")) as TrustGateCliApi;
}
async function cliTrustApi(): Promise<CliTrustApi> {
  return (await import("@/cli/trust")) as CliTrustApi;
}

// ─── Generic helpers ────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const NAX_BIN = join(REPO_ROOT, "bin", "nax.ts");
const FIXED_NOW = "2026-09-30T00:00:00.000Z";

/** tempScope: mkdtemp allocator whose cleanup removes everything it made. */
function tempScope(): { dir: (prefix: string) => string; cleanup: () => void } {
  const dirs: string[] = [];
  return {
    dir(prefix: string): string {
      const d = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(d);
      return d;
    },
    cleanup(): void {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    },
  };
}

/**
 * Save/restore an injectable `_deps` object around `fn`.
 * Mirrors test/helpers/deps.ts `withDepsRestore`, scoped to one call.
 */
async function withDeps<D extends object, T>(
  deps: D,
  overrides: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, unknown>();
  const bag = deps as unknown as Record<string, unknown>;
  for (const key of Object.keys(overrides)) {
    saved.set(key, bag[key]);
    bag[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) bag[key] = value;
  }
}

/** Point NAX_GLOBAL_CONFIG_DIR at a fresh temp dir; `restore()` puts it back. */
function isolateGlobalDir(prefix: string): { gdir: string; restore: () => void } {
  const saved = process.env.NAX_GLOBAL_CONFIG_DIR;
  const gdir = mkdtempSync(join(tmpdir(), prefix));
  process.env.NAX_GLOBAL_CONFIG_DIR = gdir;
  return {
    gdir,
    restore(): void {
      if (saved === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
      else process.env.NAX_GLOBAL_CONFIG_DIR = saved;
      rmSync(gdir, { recursive: true, force: true });
    },
  };
}

/** Run `fn` with NAX_GLOBAL_CONFIG_DIR at a fresh empty temp store. */
async function withGlobalDir<T>(prefix: string, fn: (gdir: string) => Promise<T>): Promise<T> {
  const iso = isolateGlobalDir(prefix);
  try {
    return await fn(iso.gdir);
  } finally {
    iso.restore();
  }
}

/**
 * The test-infrastructure seam US-002 provides as `useUntrustedRegistry()`
 * (test/helpers/trust.ts): a fresh empty trust store plus an emptied process
 * registry; `restore()` re-marks "/" (the preload's ambient trusted state)
 * and puts the environment back.
 */
async function enterUntrusted(
  prefix: string,
): Promise<{ t: TrustApi; gdir: string; restore: () => void }> {
  const t = await trustApi();
  const iso = isolateGlobalDir(prefix);
  t.resetTrustRegistry();
  return {
    t,
    gdir: iso.gdir,
    restore(): void {
      try {
        t.markTrusted("/");
      } finally {
        iso.restore();
      }
    },
  };
}

/** Assert a promise rejects with a NaxError carrying `code`; returns the error. */
async function expectNaxReject(promise: Promise<unknown>, code: string): Promise<NaxError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    throw new Error(`Expected promise to reject with NaxError ${code}, but it resolved`);
  }
  expect(caught).toBeInstanceOf(NaxError);
  const nax = caught as NaxError;
  expect(nax.code).toBe(code);
  return nax;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fixedEntry(path: string, via: "prompt" | "cli" = "cli"): TrustEntry {
  return { path, addedAt: FIXED_NOW, via };
}

function seedStore(gdir: string, entries: TrustEntry[]): void {
  mkdirSync(gdir, { recursive: true });
  writeFileSync(join(gdir, "trust.json"), JSON.stringify({ version: 1, folders: entries }));
}

function storeRaw(gdir: string): string {
  return readFileSync(join(gdir, "trust.json"), "utf8");
}

function parseStore(gdir: string): { version: number; folders: TrustEntry[] } {
  return JSON.parse(storeRaw(gdir)) as { version: number; folders: TrustEntry[] };
}

/** A temp project: <dir>/.nax/config.json is `{}`, dir is the realpath. */
function makeGateProject(tmp: ReturnType<typeof tempScope>, prefix: string): string {
  const dir = realpathSync(tmp.dir(prefix));
  mkdirSync(join(dir, ".nax"), { recursive: true });
  writeFileSync(join(dir, ".nax", "config.json"), "{}");
  return dir;
}

/** Valid loadable plugin module source; optionally writes a marker on import. */
function pluginModuleSource(name: string, markerPath?: string): string {
  const marker = markerPath
    ? `import { writeFileSync as __markerWrite } from "node:fs";\n__markerWrite(${JSON.stringify(markerPath)}, "imported");\n`
    : "";
  return `${marker}export default {
  name: ${JSON.stringify(name)},
  version: "1.0.0",
  provides: ["reviewer"],
  extensions: {
    reviewer: {
      name: ${JSON.stringify(`${name}-review`)},
      description: "acceptance fixture",
      async check() {
        return { passed: true, output: "OK" };
      },
    },
  },
};
`;
}

// ─── Integration spawn helper (AC-50..AC-63, AC-85, AC-86) ──────────────────

interface NaxSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `bun <repo>/bin/nax.ts <args>` as a subprocess.
 * Setup requirements: bun on PATH; NAX_GLOBAL_CONFIG_DIR is redirected to the
 * given (usually empty) temp dir; stdin "ignore"; cwd defaults to the
 * repository root. A 55 s kill timer bounds a wedged child inside the 60 s
 * per-case timeout.
 */
async function spawnNax(
  args: string[],
  opts: { globalDir: string; cwd?: string },
): Promise<NaxSpawnResult> {
  const proc = Bun.spawn(["bun", NAX_BIN, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: opts.globalDir } as Record<string, string>,
  });
  const killer = setTimeout(() => {
    try {
      proc.kill(9);
    } catch {
      /* already gone */
    }
  }, 50_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// US-001 — Trust store and path matching (AC-1..AC-23)
// ═════════════════════════════════════════════════════════════════════════════

test("AC-1: findCoveringEntry returns the exact entry whose path equals the target", async () => {
  const { findCoveringEntry } = await trustApi();
  const entry = fixedEntry("/a/foo");
  const found = findCoveringEntry([entry], "/a/foo");
  expect(found).toBe(entry);
  expect(found?.path).toBe("/a/foo");
});

test("AC-2: /a/foo covers /a/foo/bar/baz (prefix followed by / boundary)", async () => {
  const { findCoveringEntry } = await trustApi();
  const entry = fixedEntry("/a/foo");
  expect(findCoveringEntry([entry], "/a/foo/bar/baz")).toBe(entry);
});

test("AC-3: /a/foo does not cover /a/foobar (no / boundary)", async () => {
  const { findCoveringEntry } = await trustApi();
  const entry = fixedEntry("/a/foo");
  expect(findCoveringEntry([entry], "/a/foobar")).toBeNull();
});

test("AC-4: the / entry covers every absolute path", async () => {
  const { findCoveringEntry } = await trustApi();
  const rootEntry = fixedEntry("/");
  expect(findCoveringEntry([rootEntry], "/x/y")).toBe(rootEntry);
});

test("AC-5: when several entries cover, the longest path wins", async () => {
  const { findCoveringEntry } = await trustApi();
  const short = fixedEntry("/a");
  const long = fixedEntry("/a/b");
  expect(findCoveringEntry([short, long], "/a/b/c")).toBe(long);
});

test("AC-6: normalizeTrustPath resolves a not-yet-created path under a symlinked dir", async () => {
  const { normalizeTrustPath } = await trustApi();
  const tmp = tempScope();
  try {
    const target = tmp.dir("nax-trust-target-");
    const linkParent = tmp.dir("nax-trust-link-");
    const link = join(linkParent, "link");
    symlinkSync(target, link, "dir");
    const normalized = await normalizeTrustPath(join(link, "not-yet", "created"));
    const expected = join(await realpathAsync(target), "not-yet", "created");
    expect(normalized).toBe(expected);
    expect(normalized.endsWith("/")).toBe(false);
  } finally {
    tmp.cleanup();
  }
});

test("AC-7: resolveTrustRoot returns the dir containing the project .nax/config.json", async () => {
  const { resolveTrustRoot } = await trustApi();
  const tmp = tempScope();
  try {
    const project = realpathSync(tmp.dir("nax-trust-proj-"));
    mkdirSync(join(project, ".nax"), { recursive: true });
    writeFileSync(join(project, ".nax", "config.json"), "{}");
    mkdirSync(join(project, "src", "deep"), { recursive: true });
    expect(resolveTrustRoot(join(project, "src", "deep"))).toBe(project);
  } finally {
    tmp.cleanup();
  }
});

test("AC-8: with no .nax/config.json up the chain, resolveTrustRoot resolves the dir", async () => {
  const { resolveTrustRoot } = await trustApi();
  const tmp = tempScope();
  try {
    const dir = tmp.dir("nax-trust-plain-");
    expect(resolveTrustRoot(dir)).toBe(resolve(dir));
  } finally {
    tmp.cleanup();
  }
});

test("AC-9: the global ~/.nax/config.json does not collapse the trust root to home", async () => {
  const { resolveTrustRoot } = await trustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-home-");
  try {
    const home = realpathSync(tmp.dir("nax-trust-fakehome-"));
    const naxDir = join(home, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");
    const x = join(home, "x");
    mkdirSync(x, { recursive: true });
    // The AC's own precondition: NAX_GLOBAL_CONFIG_DIR is <home>/.nax, i.e.
    // realOrRaw(<home>/.nax) === realOrRaw(globalConfigDir()).
    process.env.NAX_GLOBAL_CONFIG_DIR = naxDir;
    expect(resolveTrustRoot(x)).toBe(resolve(x));
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-10: readTrustStore with no trust.json resolves to { state: 'missing' }", async () => {
  const t = await trustApi();
  await withGlobalDir("nax-trust-missing-", async () => {
    expect(await t.readTrustStore()).toEqual({ state: "missing" });
  });
});

test("AC-11: readTrustStore on invalid JSON resolves to state 'unparseable' with a reason", async () => {
  const t = await trustApi();
  await withGlobalDir("nax-trust-bad-", async (gdir) => {
    mkdirSync(gdir, { recursive: true });
    writeFileSync(join(gdir, "trust.json"), "{not json");
    const read = await t.readTrustStore();
    expect(read.state).toBe("unparseable");
    const reason = (read as { reason?: string }).reason;
    expect(typeof reason).toBe("string");
    expect((reason ?? "").length).toBeGreaterThan(0);
  });
});

test("AC-12: a version-2 store is a shape mismatch and reads as 'unparseable'", async () => {
  const t = await trustApi();
  await withGlobalDir("nax-trust-v2-", async (gdir) => {
    mkdirSync(gdir, { recursive: true });
    writeFileSync(join(gdir, "trust.json"), '{"version":2,"folders":[]}');
    const read = await t.readTrustStore();
    expect(read.state).toBe("unparseable");
    expect(read.state).not.toBe("ok");
    expect(read.state).not.toBe("missing");
  });
});

test("AC-13: addTrustEntry writes { version: 1, folders: [entry] } using _trustStoreDeps.now", async () => {
  const t = await trustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-add-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    await withDeps(t._trustStoreDeps, { now: () => new Date(FIXED_NOW) }, async () => {
      const entry = { path: dir, addedAt: FIXED_NOW, via: "cli" as const };
      const result = (await t.addTrustEntry(dir, "cli")) as { outcome: string; entry: TrustEntry };
      expect(result).toEqual({ outcome: "added", entry });
      expect(JSON.parse(storeRaw(iso.gdir))).toEqual({ version: 1, folders: [entry] });
    });
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-14: trust.json is written with mode 0o600", async () => {
  const t = await trustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-mode-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    await t.addTrustEntry(dir, "cli");
    const st = await statAsync(join(iso.gdir, "trust.json"));
    expect(st.mode & 0o777).toBe(0o600);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-15: addTrustEntry creates a missing global config dir before locking", async () => {
  const t = await trustApi();
  const tmp = tempScope();
  const missing = join(tmp.dir("nax-trust-shell-"), "does", "not", "exist");
  const saved = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = missing;
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    const result = (await t.addTrustEntry(dir, "cli")) as { outcome: string };
    expect(result.outcome).toBe("added");
    expect(existsSync(join(missing, "trust.json"))).toBe(true);
  } finally {
    if (saved === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = saved;
    tmp.cleanup();
  }
});

test("AC-16: addTrustEntry of an already-covered child returns already-covered without writing", async () => {
  const t = await trustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-covered-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    const e = fixedEntry(dir);
    seedStore(iso.gdir, [e]);
    const snapshot = storeRaw(iso.gdir);
    const result = (await t.addTrustEntry(join(dir, "child"), "cli")) as {
      outcome: string;
      coveredBy: TrustEntry;
    };
    expect(result).toEqual({ outcome: "already-covered", coveredBy: e });
    expect(result.coveredBy.path).toBe(dir);
    expect(storeRaw(iso.gdir)).toBe(snapshot);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-17: addTrustEntry on an unparseable store rejects TRUST_STORE_UNREADABLE and leaves bytes", async () => {
  const t = await trustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-addbad-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    mkdirSync(iso.gdir, { recursive: true });
    writeFileSync(join(iso.gdir, "trust.json"), "{not json");
    const snapshot = storeRaw(iso.gdir);
    await expectNaxReject(t.addTrustEntry(dir, "cli"), "TRUST_STORE_UNREADABLE");
    expect(storeRaw(iso.gdir)).toBe(snapshot);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-18: two concurrent addTrustEntry calls both land (no lost update, no duplicate)", async () => {
  const t = await trustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-concurrent-");
  try {
    const dirA = realpathSync(tmp.dir("nax-trust-a-"));
    const dirB = realpathSync(tmp.dir("nax-trust-b-"));
    const results = (await Promise.all([
      t.addTrustEntry(dirA, "cli"),
      t.addTrustEntry(dirB, "cli"),
    ])) as Array<{ outcome: string }>;
    expect(results.map((r) => r.outcome)).toEqual(["added", "added"]);
    const parsed = parseStore(iso.gdir);
    expect(parsed.version).toBe(1);
    expect(parsed.folders.filter((f) => f.path === dirA)).toHaveLength(1);
    expect(parsed.folders.filter((f) => f.path === dirB)).toHaveLength(1);
    expect(parsed.folders).toHaveLength(2);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-19: removeTrustEntry removes exactly the matching entry", async () => {
  const t = await trustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-rm-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    const e = fixedEntry(dir);
    seedStore(iso.gdir, [e]);
    const result = (await t.removeTrustEntry(dir)) as { outcome: string; entry: TrustEntry };
    expect(result).toEqual({ outcome: "removed", entry: e });
    const parsed = parseStore(iso.gdir);
    expect(parsed.folders.some((f) => f.path === dir)).toBe(false);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-20: removeTrustEntry only removes an exact-path match (not-found keeps bytes)", async () => {
  const t = await trustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-rmchild-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    const e = fixedEntry(dir);
    seedStore(iso.gdir, [e]);
    const snapshot = storeRaw(iso.gdir);
    const result = (await t.removeTrustEntry(join(dir, "child"))) as {
      outcome: string;
      coveredBy: TrustEntry;
    };
    expect(result).toEqual({ outcome: "not-found", coveredBy: e });
    expect(result.coveredBy.path).toBe(dir);
    expect(storeRaw(iso.gdir)).toBe(snapshot);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-21: removeTrustEntry on an unparseable store rejects TRUST_STORE_UNREADABLE, bytes intact", async () => {
  const t = await trustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-rmbad-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    mkdirSync(iso.gdir, { recursive: true });
    writeFileSync(join(iso.gdir, "trust.json"), "{not json");
    const snapshot = storeRaw(iso.gdir);
    await expectNaxReject(t.removeTrustEntry(dir), "TRUST_STORE_UNREADABLE");
    expect(storeRaw(iso.gdir)).toBe(snapshot);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-22: removeTrustEntry with a missing global dir returns not-found and creates nothing", async () => {
  const t = await trustApi();
  const tmp = tempScope();
  const missing = join(tmp.dir("nax-trust-shell-"), "absent");
  const saved = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = missing;
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    const result = await t.removeTrustEntry(dir);
    expect(result).toEqual({ outcome: "not-found", coveredBy: null });
    expect(existsSync(missing)).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = saved;
    tmp.cleanup();
  }
});

test("AC-23: rejectGlobalOnlyKeys throws TRUST_CONFIG_NOT_GLOBAL for trust; auth handling unchanged", () => {
  let trustErr: unknown;
  try {
    rejectGlobalOnlyKeys({ trust: {} }, "project config");
  } catch (err) {
    trustErr = err;
  }
  expect(trustErr).toBeInstanceOf(NaxError);
  const nax = trustErr as NaxError;
  expect(nax.code).toBe("TRUST_CONFIG_NOT_GLOBAL");
  expect(nax.message).toBe("trust is global-only and cannot be set in project config");
  expect(nax.context).toEqual({ stage: "config", layerName: "project config" });

  let authErr: unknown;
  try {
    rejectGlobalOnlyKeys({ auth: {} }, "project config");
  } catch (err) {
    authErr = err;
  }
  expect(authErr).toBeInstanceOf(NaxError);
  expect((authErr as NaxError).code).toBe("AUTH_CONFIG_NOT_GLOBAL");
});

// ═════════════════════════════════════════════════════════════════════════════
// US-002 — Trust registry, prompt and entry gate (AC-24..AC-45)
// ═════════════════════════════════════════════════════════════════════════════

test("AC-24: assertTrusted with an empty registry rejects PROJECT_UNTRUSTED naming the surface", async () => {
  const un = await enterUntrusted("nax-trust-assert-");
  try {
    const dir = realpathSync(un.gdir);
    const err = await expectNaxReject(un.t.assertTrusted(dir, "hooks"), "PROJECT_UNTRUSTED");
    expect(err.context?.surface).toBe("hooks");
  } finally {
    un.restore();
  }
});

test("AC-25: a marked root covers child paths (segment-bounded)", async () => {
  const un = await enterUntrusted("nax-trust-mark-");
  try {
    const dir = realpathSync(un.gdir);
    const root = await un.t.normalizeTrustPath(dir);
    un.t.markTrusted(root);
    await un.t.assertTrusted((await un.t.normalizeTrustPath(dir)) + "/sub", "plugins");
  } finally {
    un.restore();
  }
});

test("AC-26: /a/foobar is not covered by a mark on /a/foo", async () => {
  const un = await enterUntrusted("nax-trust-seg-");
  try {
    un.t.markTrusted("/a/foo");
    await expectNaxReject(un.t.assertTrusted("/a/foobar", "plugins"), "PROJECT_UNTRUSTED");
  } finally {
    un.restore();
  }
});

test("AC-27: resetTrustRegistry empties the process-scoped registry", async () => {
  const un = await enterUntrusted("nax-trust-reset-");
  try {
    const dir = realpathSync(un.gdir);
    un.t.markTrusted(dir);
    un.t.resetTrustRegistry();
    await expectNaxReject(un.t.assertTrusted(dir, "plugins"), "PROJECT_UNTRUSTED");
  } finally {
    un.restore();
  }
});

test("AC-28: a covering store entry satisfies ensureProjectTrusted without prompting", async () => {
  const un = await enterUntrusted("nax-trust-gateok-");
  try {
    const dir = realpathSync(un.gdir);
    mkdirSync(join(dir, ".nax"), { recursive: true });
    writeFileSync(join(dir, ".nax", "config.json"), "{}");
    seedStore(un.gdir, [fixedEntry(dir)]);
    const promptSpy = mock(async () => {
      throw new Error("prompt must not be called");
    });
    await withDeps(un.t._trustGateDeps, { prompt: promptSpy }, async () => {
      await un.t.ensureProjectTrusted(dir, { interactive: false });
      expect(promptSpy).not.toHaveBeenCalled();
      await un.t.assertTrusted(dir + "/x", "mcp");
    });
  } finally {
    un.restore();
  }
});

test("AC-29: non-interactive gate with no store rejects PROJECT_UNTRUSTED with root and hint", async () => {
  const un = await enterUntrusted("nax-trust-gateno-");
  try {
    const dir = realpathSync(un.gdir);
    const err = await expectNaxReject(
      un.t.ensureProjectTrusted(dir, { interactive: false }),
      "PROJECT_UNTRUSTED",
    );
    expect(err.context?.root).toBe(dir);
    expect(err.context?.hint).toBe("run: nax trust add " + dir);
  } finally {
    un.restore();
  }
});

test("AC-30: the non-interactive gate never calls _trustGateDeps.prompt", async () => {
  const un = await enterUntrusted("nax-trust-gatenoprompt-");
  try {
    const dir = realpathSync(un.gdir);
    const promptSpy = mock(async (): Promise<"no"> => "no");
    await withDeps(un.t._trustGateDeps, { prompt: promptSpy }, async () => {
      await expectNaxReject(un.t.ensureProjectTrusted(dir, { interactive: false }), "PROJECT_UNTRUSTED");
      expect(promptSpy).toHaveBeenCalledTimes(0);
    });
  } finally {
    un.restore();
  }
});

test("AC-31: interactive gate prompts once with (root, dirname(root))", async () => {
  const un = await enterUntrusted("nax-trust-gateprompt-");
  try {
    const dir = realpathSync(un.gdir);
    const promptMock = mock(async (): Promise<"no"> => "no");
    await withDeps(un.t._trustGateDeps, { prompt: promptMock }, async () => {
      await expectNaxReject(un.t.ensureProjectTrusted(dir, { interactive: true }), "PROJECT_UNTRUSTED");
      expect(promptMock).toHaveBeenCalledTimes(1);
      expect(promptMock).toHaveBeenCalledWith(dir, dirname(dir));
    });
  } finally {
    un.restore();
  }
});

test("AC-32: a 'yes' answer persists the root with via 'prompt'", async () => {
  const un = await enterUntrusted("nax-trust-yes-");
  try {
    const dir = realpathSync(un.gdir);
    const promptMock = mock(async (): Promise<"yes"> => "yes");
    await withDeps(un.t._trustGateDeps, { prompt: promptMock }, async () => {
      await un.t.ensureProjectTrusted(dir, { interactive: true });
      const read = await un.t.readTrustStore();
      expect(read.state).toBe("ok");
      const folders = read.state === "ok" ? read.file.folders : [];
      const entry = folders.find((f) => f.path === dir);
      expect(entry).toBeDefined();
      expect(entry?.via).toBe("prompt");
    });
  } finally {
    un.restore();
  }
});

test("AC-33: after a 'yes' answer, assertTrusted on the root resolves", async () => {
  const un = await enterUntrusted("nax-trust-yesassert-");
  try {
    const dir = realpathSync(un.gdir);
    const promptMock = mock(async (): Promise<"yes"> => "yes");
    await withDeps(un.t._trustGateDeps, { prompt: promptMock }, async () => {
      await un.t.ensureProjectTrusted(dir, { interactive: true });
      await un.t.assertTrusted(dir, "hooks");
    });
  } finally {
    un.restore();
  }
});

test("AC-34: a 'parent' answer persists dirname(root) with via 'prompt'", async () => {
  const un = await enterUntrusted("nax-trust-parent-");
  try {
    const dir = realpathSync(un.gdir);
    const promptMock = mock(async (): Promise<"parent"> => "parent");
    await withDeps(un.t._trustGateDeps, { prompt: promptMock }, async () => {
      await un.t.ensureProjectTrusted(dir, { interactive: true });
      const read = await un.t.readTrustStore();
      expect(read.state).toBe("ok");
      const folders = read.state === "ok" ? read.file.folders : [];
      const entry = folders.find((f) => f.path === dirname(dir));
      expect(entry).toBeDefined();
      expect(entry?.via).toBe("prompt");
    });
  } finally {
    un.restore();
  }
});

test("AC-35: a 'no' answer rejects PROJECT_UNTRUSTED and writes no store", async () => {
  const un = await enterUntrusted("nax-trust-no-");
  try {
    const dir = realpathSync(un.gdir);
    const promptMock = mock(async (): Promise<"no"> => "no");
    await withDeps(un.t._trustGateDeps, { prompt: promptMock }, async () => {
      await expectNaxReject(un.t.ensureProjectTrusted(dir, { interactive: true }), "PROJECT_UNTRUSTED");
      expect(existsSync(join(un.gdir, "trust.json"))).toBe(false);
    });
  } finally {
    un.restore();
  }
});

test("AC-36: an unparseable store makes the gate throw TRUST_STORE_UNREADABLE without prompting", async () => {
  const un = await enterUntrusted("nax-trust-gatebad-");
  try {
    const dir = realpathSync(un.gdir);
    mkdirSync(un.gdir, { recursive: true });
    writeFileSync(join(un.gdir, "trust.json"), "{not json");
    const promptSpy = mock(async (): Promise<"no"> => "no");
    await withDeps(un.t._trustGateDeps, { prompt: promptSpy }, async () => {
      await expectNaxReject(
        un.t.ensureProjectTrusted(dir, { interactive: true }),
        "TRUST_STORE_UNREADABLE",
      );
      expect(promptSpy).toHaveBeenCalledTimes(0);
    });
  } finally {
    un.restore();
  }
});

test("AC-37: promptTrustChoice maps 'Y' to 'yes'", async () => {
  const t = await trustApi();
  const ask = mock(async (): Promise<string | null> => "Y");
  await withDeps(t._trustPromptDeps, { ask }, async () => {
    expect(await t.promptTrustChoice("/r/p", "/r")).toBe("yes");
  });
});

test("AC-38: promptTrustChoice trims and maps ' parent ' to 'parent'", async () => {
  const t = await trustApi();
  const ask = mock(async (): Promise<string | null> => " parent ");
  await withDeps(t._trustPromptDeps, { ask }, async () => {
    expect(await t.promptTrustChoice("/r/p", "/r")).toBe("parent");
  });
});

test("AC-39: an empty line maps to 'no'", async () => {
  const t = await trustApi();
  const ask = mock(async (): Promise<string | null> => "");
  await withDeps(t._trustPromptDeps, { ask }, async () => {
    expect(await t.promptTrustChoice("/r/p", "/r")).toBe("no");
  });
});

test("AC-40: end of input (null) maps to 'no'", async () => {
  const t = await trustApi();
  const ask = mock(async (): Promise<string | null> => null);
  await withDeps(t._trustPromptDeps, { ask }, async () => {
    expect(await t.promptTrustChoice("/r/p", "/r")).toBe("no");
  });
});

test("AC-41: promptTrustChoice asks the exact parent-variant question (trailing space)", async () => {
  const t = await trustApi();
  const askSpy = mock(async (): Promise<string | null> => "y");
  await withDeps(t._trustPromptDeps, { ask: askSpy }, async () => {
    await t.promptTrustChoice("/r/p", "/r");
    expect(askSpy).toHaveBeenCalledTimes(1);
    expect(askSpy).toHaveBeenCalledWith(
      "Trust /r/p? nax will run this project's plugins, hooks, MCP servers and test commands. [y]es / [p]arent (/r) / [N]o ",
    );
  });
});

test("AC-42: 'p' with a null parent maps to 'no'", async () => {
  const t = await trustApi();
  const ask = mock(async (): Promise<string | null> => "p");
  await withDeps(t._trustPromptDeps, { ask }, async () => {
    expect(await t.promptTrustChoice("/r/p", null)).toBe("no");
  });
});

test("AC-43: with a null parent the question has no parent option (trailing space)", async () => {
  const t = await trustApi();
  const askSpy = mock(async (): Promise<string | null> => "y");
  await withDeps(t._trustPromptDeps, { ask: askSpy }, async () => {
    await t.promptTrustChoice("/home/u/p", null);
    expect(askSpy).toHaveBeenCalledTimes(1);
    expect(askSpy).toHaveBeenCalledWith(
      "Trust /home/u/p? nax will run this project's plugins, hooks, MCP servers and test commands. [y]es / [N]o ",
    );
  });
});

test("AC-44: a project directly under the protected home prompts with a null parent", async () => {
  const un = await enterUntrusted("nax-trust-homep-");
  try {
    const home = realpathSync(un.gdir);
    const project = join(home, "p");
    mkdirSync(project, { recursive: true });
    const promptMock = mock(async (): Promise<"no"> => "no");
    await withDeps(un.t._trustGateDeps, { homedir: () => home, prompt: promptMock }, async () => {
      await expectNaxReject(
        un.t.ensureProjectTrusted(project, { interactive: true }),
        "PROJECT_UNTRUSTED",
      );
      expect(promptMock).toHaveBeenCalledWith(project, null);
    });
  } finally {
    un.restore();
  }
});

test("AC-45: the home directory itself is refused with the --force hint and no prompt", async () => {
  const un = await enterUntrusted("nax-trust-homeforce-");
  try {
    const home = realpathSync(un.gdir);
    const promptSpy = mock(async (): Promise<"no"> => "no");
    await withDeps(un.t._trustGateDeps, { homedir: () => home, prompt: promptSpy }, async () => {
      const err = await expectNaxReject(
        un.t.ensureProjectTrusted(home, { interactive: true }),
        "PROJECT_UNTRUSTED",
      );
      expect(err.context?.hint).toBe("run: nax trust add " + home + " --force");
      expect(promptSpy).toHaveBeenCalledTimes(0);
    });
  } finally {
    un.restore();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// US-003 — CLI gate helper, unit side (AC-46..AC-49)
// ═════════════════════════════════════════════════════════════════════════════

const EXIT_SENTINEL = new Error("exit sentinel: runTrustGate called exit");

test("AC-46: runTrustGate with no store and no TTY calls exit(2) via the sentinel", async () => {
  const un = await enterUntrusted("nax-trust-rgate-");
  try {
    const dir = realpathSync(un.gdir);
    const exitCalls: number[] = [];
    const api = await trustGateCliApi();
    await withDeps(api._trustGateCliDeps, {
      isInteractive: () => false,
      error: (_text: string) => {},
      exit: ((code: number) => {
        exitCalls.push(code);
        throw EXIT_SENTINEL;
      }) as (code: number) => never,
    }, async () => {
      let caught: unknown;
      try {
        await api.runTrustGate(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(EXIT_SENTINEL);
      expect(exitCalls).toEqual([2]);
    });
  } finally {
    un.restore();
  }
});

test("AC-47: runTrustGate prints both refusal lines in order, then exits 2", async () => {
  const un = await enterUntrusted("nax-trust-rgateorder-");
  try {
    const dir = realpathSync(un.gdir);
    const events: string[] = [];
    const api = await trustGateCliApi();
    await withDeps(api._trustGateCliDeps, {
      isInteractive: () => false,
      error: (text: string) => {
        events.push(`error:${text}`);
      },
      exit: ((code: number) => {
        events.push(`exit:${String(code)}`);
        throw EXIT_SENTINEL;
      }) as (code: number) => never,
    }, async () => {
      let caught: unknown;
      try {
        await api.runTrustGate(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(EXIT_SENTINEL);
      expect(events).toEqual([
        `error:Project not trusted: ${dir}`,
        `error:run: nax trust add ${dir}`,
        "exit:2",
      ]);
    });
  } finally {
    un.restore();
  }
});

test("AC-48: runTrustGate on an unparseable store exits 2 with no stdout output", async () => {
  const un = await enterUntrusted("nax-trust-rgatebad-");
  try {
    const dir = realpathSync(un.gdir);
    mkdirSync(un.gdir, { recursive: true });
    writeFileSync(join(un.gdir, "trust.json"), "{not json");
    const exitCalls: number[] = [];
    const stdoutLines: string[] = [];
    const savedLog = console.log;
    console.log = (text?: unknown) => {
      stdoutLines.push(String(text));
    };
    const api = await trustGateCliApi();
    try {
      await withDeps(api._trustGateCliDeps, {
        isInteractive: () => false,
        error: (_text: string) => {},
        exit: ((code: number) => {
          exitCalls.push(code);
          throw EXIT_SENTINEL;
        }) as (code: number) => never,
      }, async () => {
        let caught: unknown;
        try {
          await api.runTrustGate(dir);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBe(EXIT_SENTINEL);
        expect(exitCalls).toEqual([2]);
        expect(stdoutLines).toEqual([]);
      });
    } finally {
      console.log = savedLog;
    }
  } finally {
    un.restore();
  }
});

test("AC-49: a covering store entry lets runTrustGate return without exit or error", async () => {
  const un = await enterUntrusted("nax-trust-rgateok-");
  try {
    const dir = realpathSync(un.gdir);
    mkdirSync(join(dir, ".nax"), { recursive: true });
    writeFileSync(join(dir, ".nax", "config.json"), "{}");
    mkdirSync(join(dir, "src"), { recursive: true });
    seedStore(un.gdir, [fixedEntry(dir)]);
    const exitCalls: number[] = [];
    const errorCalls: string[] = [];
    const api = await trustGateCliApi();
    await withDeps(api._trustGateCliDeps, {
      isInteractive: () => false,
      error: (text: string) => {
        errorCalls.push(text);
      },
      exit: ((code: number) => {
        exitCalls.push(code);
        throw EXIT_SENTINEL;
      }) as (code: number) => never,
    }, async () => {
      const normalized = await un.t.normalizeTrustPath(join(dir, "src"));
      await api.runTrustGate(normalized);
      expect(exitCalls).toEqual([]);
      expect(errorCalls).toEqual([]);
    });
  } finally {
    un.restore();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// US-003 — Gated CLI commands, integration side (AC-50..AC-63)
//
// Setup: every case spawns `bun <repo>/bin/nax.ts ...` with NAX_GLOBAL_CONFIG_DIR
// pointed at an empty temp dir (no trust.json) unless the AC says otherwise,
// stdin "ignore", cwd = repository root, and a temp project whose
// .nax/config.json is "{}". Per-case timeout 60 000 ms.
// ═════════════════════════════════════════════════════════════════════════════

test("AC-50: nax run --headless exits 2 when the project is untrusted", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-run-");
    const result = await spawnNax(["run", "-f", "demo", "-d", dir, "--headless"], {
      globalDir: tmp.dir("nax-trust-run-global-"),
    });
    expect(result.exitCode).toBe(2);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-51: the untrusted run refusal names `nax trust add <root>` on stderr", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-runmsg-");
    const result = await spawnNax(["run", "-f", "demo", "-d", dir, "--headless"], {
      globalDir: tmp.dir("nax-trust-runmsg-global-"),
    });
    expect(result.stderr).toContain("run: nax trust add " + dir);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-52: the gate fires before project plugins are imported (sentinel never runs)", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-sentinel-");
    const marker = join(dir, "imported");
    const pluginsDir = join(dir, ".nax", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "sentinel.ts"), pluginModuleSource("sentinel", marker));
    const result = await spawnNax(["run", "-f", "demo", "-d", dir, "--headless"], {
      globalDir: tmp.dir("nax-trust-sentinel-global-"),
    });
    expect(result.exitCode).toBe(2);
    expect(existsSync(marker)).toBe(false);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-53: with --schedule 1h the gate fires well before the deferred wait", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-sched-");
    const started = Date.now();
    const result = await spawnNax(["run", "-f", "demo", "-d", dir, "--headless", "--schedule", "1h"], {
      globalDir: tmp.dir("nax-trust-sched-global-"),
    });
    expect(result.exitCode).toBe(2);
    expect(Date.now() - started).toBeLessThan(30_000);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-54: nax resume exits 2 when the project is untrusted", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-resume-");
    const result = await spawnNax(["resume", "-f", "demo", "-d", dir], {
      globalDir: tmp.dir("nax-trust-resume-global-"),
    });
    expect(result.exitCode).toBe(2);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-55: nax plan --from <spec> exits 2 when the project is untrusted", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-plan-");
    writeFileSync(join(dir, "spec.md"), "# Demo spec\n");
    const result = await spawnNax(["plan", "-f", "demo", "--from", join(dir, "spec.md"), "-d", dir], {
      globalDir: tmp.dir("nax-trust-plan-global-"),
    });
    expect(result.exitCode).toBe(2);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-56: nax plugins list exits 2 when the project is untrusted", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-plugins-");
    const result = await spawnNax(["plugins", "list", "-d", dir], {
      globalDir: tmp.dir("nax-trust-plugins-global-"),
    });
    expect(result.exitCode).toBe(2);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-57: nax setup --dry-run exits 2 when the project is untrusted", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-setup-");
    const result = await spawnNax(["setup", "-d", dir, "--dry-run"], {
      globalDir: tmp.dir("nax-trust-setup-global-"),
    });
    expect(result.exitCode).toBe(2);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-58: nax precheck exits 2 when the project is untrusted", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-precheck-");
    const result = await spawnNax(["precheck", "-f", "demo", "-d", dir], {
      globalDir: tmp.dir("nax-trust-precheck-global-"),
    });
    expect(result.exitCode).toBe(2);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-59: nax prompts (no --init/--export) exits 2 when the project is untrusted", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-prompts-");
    const result = await spawnNax(["prompts", "-f", "demo", "-d", dir], {
      globalDir: tmp.dir("nax-trust-prompts-global-"),
    });
    expect(result.exitCode).toBe(2);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-60: nax prompts --export bypasses the gate and exits 0", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-export-");
    const result = await spawnNax(["prompts", "--export", "implementer", "-d", dir], {
      globalDir: tmp.dir("nax-trust-export-global-"),
    });
    expect(result.exitCode).toBe(0);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-61: nax mcp lock (cwd = project) exits 2 when untrusted", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-mcplock-");
    const result = await spawnNax(["mcp", "lock"], {
      globalDir: tmp.dir("nax-trust-mcplock-global-"),
      cwd: dir,
    });
    expect(result.exitCode).toBe(2);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-62: nax plugins list exits 0 when the store covers the project", async () => {
  const tmp = tempScope();
  const globalDir = tmp.dir("nax-trust-trusted-global-");
  try {
    const dir = makeGateProject(tmp, "nax-trust-trusted-");
    seedStore(globalDir, [fixedEntry(dir)]);
    const result = await spawnNax(["plugins", "list", "-d", dir], { globalDir });
    expect(result.exitCode).toBe(0);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-63: nax config --json is ungated and exits 0", async () => {
  const tmp = tempScope();
  try {
    const dir = makeGateProject(tmp, "nax-trust-config-");
    const result = await spawnNax(["config", "--json"], {
      globalDir: tmp.dir("nax-trust-config-global-"),
      cwd: dir,
    });
    expect(result.exitCode).toBe(0);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
// US-004 — `nax trust` command handlers, unit side (AC-64..AC-84)
// ═════════════════════════════════════════════════════════════════════════════

test("AC-64: trust list stars the entry covering cwd and indents the rest", async () => {
  const t = await trustApi();
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-list-");
  try {
    const a = realpathSync(tmp.dir("nax-trust-a-"));
    const b = realpathSync(tmp.dir("nax-trust-b-"));
    seedStore(iso.gdir, [fixedEntry(a), fixedEntry(b)]);
    const logs: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (_text: string) => {},
      cwd: () => join(a, "x"),
    }, async () => {
      const code = await api.trustListCommand({});
      expect(code).toBe(0);
      const starRe = new RegExp(`^\\* ${escapeRegExp(a)}  \\(via cli, added .+\\)$`);
      const indentRe = new RegExp(`^  ${escapeRegExp(b)}  \\(via cli, added .+\\)$`);
      const lines = logs.join("\n").split("\n");
      expect(lines.filter((l) => starRe.test(l))).toHaveLength(1);
      expect(lines.filter((l) => indentRe.test(l))).toHaveLength(1);
    });
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-65: trust list --json prints exactly the store document with coveringCwd", async () => {
  const t = await trustApi();
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-listjson-");
  try {
    const a = realpathSync(tmp.dir("nax-trust-a-"));
    const e = fixedEntry(a);
    seedStore(iso.gdir, [e]);
    const logs: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (_text: string) => {},
      cwd: () => a,
    }, async () => {
      const code = await api.trustListCommand({ json: true });
      expect(code).toBe(0);
      const expected = JSON.stringify({ path: t.trustStorePath(), folders: [e], coveringCwd: a }, null, 2);
      expect(logs).toEqual([expected]);
      const parsed = JSON.parse(logs[0] ?? "{}") as {
        path: string;
        folders: TrustEntry[];
        coveringCwd: string;
      };
      expect(parsed.path).toBe(t.trustStorePath());
      expect(parsed.folders).toHaveLength(1);
      expect(parsed.folders[0]?.path).toBe(a);
      expect(parsed.coveringCwd).toBe(a);
    });
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-66: trust add <dir> --yes adds the dir with via 'cli' and exits 0", async () => {
  const t = await trustApi();
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-addcli-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    await withDeps(api._cliTrustDeps, {
      log: (_text: string) => {},
      error: (_text: string) => {},
    }, async () => {
      const code = await api.trustAddCommand({ path: dir, yes: true });
      expect(code).toBe(0);
    });
    expect(existsSync(join(iso.gdir, "trust.json"))).toBe(true);
    const parsed = parseStore(iso.gdir);
    const entries = parsed.folders.filter((f) => f.path === dir && f.via === "cli");
    expect(entries).toHaveLength(1);
    expect(parsed.folders).toHaveLength(1);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-67: trust add --yes with no path uses cwd", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-addcwd-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    await withDeps(api._cliTrustDeps, {
      log: (_text: string) => {},
      error: (_text: string) => {},
      cwd: () => dir,
    }, async () => {
      const code = await api.trustAddCommand({ yes: true });
      expect(code).toBe(0);
    });
    const parsed = parseStore(iso.gdir);
    expect(parsed.folders).toHaveLength(1);
    expect(parsed.folders[0]?.path).toBe(dir);
    expect(parsed.folders[0]?.via).toBe("cli");
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-68: adding an already-covered path logs the covered-by line and adds nothing", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-already-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    seedStore(iso.gdir, [fixedEntry(dir)]);
    const logs: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (_text: string) => {},
    }, async () => {
      const code = await api.trustAddCommand({ path: join(dir, "c"), yes: true });
      expect(code).toBe(0);
      expect(logs).toContain(`Already trusted: ${join(dir, "c")} is covered by ${dir}`);
    });
    const parsed = parseStore(iso.gdir);
    expect(parsed.folders).toHaveLength(1);
    expect(parsed.folders[0]?.path).toBe(dir);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-69: trusting / without --force refuses with exit 1 and no store", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-root-");
  try {
    const errors: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (_text: string) => {},
      error: (text: string) => {
        errors.push(text);
      },
    }, async () => {
      const code = await api.trustAddCommand({ path: "/", yes: true });
      expect(code).toBe(1);
      expect(errors.some((e) =>
        e.includes("Refusing to trust /: it covers every project under it. Pass --force to trust it anyway.")
      )).toBe(true);
      expect(errors.some((e) => e.includes("Pass --force"))).toBe(true);
    });
    expect(existsSync(join(iso.gdir, "trust.json"))).toBe(false);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-70: trusting the home directory without --force refuses with exit 1", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-homeadd-");
  try {
    const home = realpathSync(tmp.dir("nax-trust-fakehome-"));
    const errors: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (_text: string) => {},
      error: (text: string) => {
        errors.push(text);
      },
      homedir: () => home,
    }, async () => {
      const code = await api.trustAddCommand({ path: home, yes: true });
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes("Pass --force"))).toBe(true);
    });
    expect(existsSync(join(iso.gdir, "trust.json"))).toBe(false);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-71: trusting / with --force succeeds and stores the / entry", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-rootforce-");
  try {
    const logs: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (_text: string) => {},
    }, async () => {
      const code = await api.trustAddCommand({ path: "/", yes: true, force: true });
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes("Trusted /"))).toBe(true);
    });
    const parsed = parseStore(iso.gdir);
    expect(parsed.folders.some((f) => f.path === "/")).toBe(true);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-72: the protected-folder refusal precedes the already-covered check", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-order12-");
  try {
    seedStore(iso.gdir, [fixedEntry("/")]);
    const logs: string[] = [];
    const errors: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (text: string) => {
        errors.push(text);
      },
    }, async () => {
      const code = await api.trustAddCommand({ path: "/", yes: true });
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes("Pass --force"))).toBe(true);
      expect(logs.some((l) => l.includes("Already trusted"))).toBe(false);
    });
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-73: the protected-root check precedes the TTY check", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-order13-");
  try {
    const home = realpathSync(tmp.dir("nax-trust-fakehome-"));
    const logs: string[] = [];
    const errors: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (text: string) => {
        errors.push(text);
      },
      homedir: () => home,
      isTTY: () => false,
    }, async () => {
      const code = await api.trustAddCommand({ path: home });
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes("Pass --force"))).toBe(true);
      const all = [...logs, ...errors].join("\n");
      expect(all.includes("stdin is not a TTY")).toBe(false);
    });
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-74: the already-covered check precedes the TTY check and never confirms", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-order23-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    seedStore(iso.gdir, [fixedEntry(dir)]);
    const logs: string[] = [];
    const confirmMock = mock(async (): Promise<boolean> => true);
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (_text: string) => {},
      isTTY: () => false,
      confirm: confirmMock,
    }, async () => {
      const code = await api.trustAddCommand({ path: join(dir, "c") });
      expect(code).toBe(0);
      expect(logs).toContain(`Already trusted: ${join(dir, "c")} is covered by ${dir}`);
      expect(confirmMock).toHaveBeenCalledTimes(0);
    });
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-75: non-interactive add without --yes refuses, never confirms, writes nothing", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-nottty-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    const errors: string[] = [];
    const confirmMock = mock(async (): Promise<boolean> => true);
    await withDeps(api._cliTrustDeps, {
      log: (_text: string) => {},
      error: (text: string) => {
        errors.push(text);
      },
      isTTY: () => false,
      confirm: confirmMock,
    }, async () => {
      const code = await api.trustAddCommand({ path: dir });
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes(`Refusing to trust ${dir} without confirmation`))).toBe(true);
      expect(errors.some((e) => e.includes("Pass --yes"))).toBe(true);
      expect(confirmMock).toHaveBeenCalledTimes(0);
    });
    expect(existsSync(join(iso.gdir, "trust.json"))).toBe(false);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-76: a declined interactive confirmation logs 'Not trusted.' and writes nothing", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-decline-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    const logs: string[] = [];
    const confirmMock = mock(async (): Promise<boolean> => false);
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (_text: string) => {},
      isTTY: () => true,
      confirm: confirmMock,
    }, async () => {
      const code = await api.trustAddCommand({ path: dir });
      expect(code).toBe(1);
      expect(confirmMock).toHaveBeenCalledTimes(1);
      expect(logs.some((l) => l.includes("Not trusted."))).toBe(true);
    });
    expect(existsSync(join(iso.gdir, "trust.json"))).toBe(false);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-77: a confirmed interactive add trusts the dir via 'cli'", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-confirm-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    const logs: string[] = [];
    const confirmMock = mock(async (): Promise<boolean> => true);
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (_text: string) => {},
      isTTY: () => true,
      confirm: confirmMock,
    }, async () => {
      const code = await api.trustAddCommand({ path: dir });
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes(`Trusted ${dir}`))).toBe(true);
    });
    const parsed = parseStore(iso.gdir);
    expect(parsed.folders).toHaveLength(1);
    expect(parsed.folders[0]?.path).toBe(dir);
    expect(parsed.folders[0]?.via).toBe("cli");
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-78: trust rm of an exact entry removes it and logs 'Removed <dir>'", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-rmcli-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    seedStore(iso.gdir, [fixedEntry(dir)]);
    const logs: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (_text: string) => {},
    }, async () => {
      const code = await api.trustRmCommand({ path: dir });
      expect(code).toBe(0);
      expect(logs).toContain(`Removed ${dir}`);
    });
    const parsed = parseStore(iso.gdir);
    expect(parsed.folders.some((f) => f.path === dir)).toBe(false);
    expect(parsed.folders).toHaveLength(0);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-79: trust rm with no store reports 'No trust entry for <dir>' and exits 1", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-rmnone-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    const errors: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (_text: string) => {},
      error: (text: string) => {
        errors.push(text);
      },
    }, async () => {
      const code = await api.trustRmCommand({ path: dir });
      expect(code).toBe(1);
      expect(errors).toContain(`No trust entry for ${dir}`);
      expect(errors.some((e) => e.includes("is still trusted through"))).toBe(false);
    });
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-80: trust rm of a covered child names the covering entry and keeps the store", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-rmcovered-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    const e = fixedEntry(dir);
    seedStore(iso.gdir, [e]);
    const errors: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (_text: string) => {},
      error: (text: string) => {
        errors.push(text);
      },
    }, async () => {
      const code = await api.trustRmCommand({ path: join(dir, "c") });
      expect(code).toBe(1);
      expect(errors.some((x) => x.includes(`No trust entry for ${join(dir, "c")}`))).toBe(true);
      expect(errors.some((x) => x.includes(`${join(dir, "c")} is still trusted through ${dir}`))).toBe(true);
    });
    const parsed = parseStore(iso.gdir);
    expect(parsed.folders).toEqual([e]);
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-81: trust check on a trusted root exits 0 and logs 'trusted: <dir>'", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-checkyes-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    seedStore(iso.gdir, [fixedEntry(dir)]);
    const logs: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (_text: string) => {},
    }, async () => {
      const code = await api.trustCheckCommand({ path: dir });
      expect(code).toBe(0);
      expect(logs.some((l) => l.startsWith(`trusted: ${dir}`))).toBe(true);
      expect(logs.some((l) => l.startsWith("untrusted: "))).toBe(false);
    });
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-82: trust check with no store exits 1 and logs 'untrusted: <dir>'", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-checkno-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    const logs: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (_text: string) => {},
    }, async () => {
      const code = await api.trustCheckCommand({ path: dir });
      expect(code).toBe(1);
      expect(logs.some((l) => l.startsWith(`untrusted: ${dir}`))).toBe(true);
    });
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-83: trust check --json prints exactly the root/trusted/coveredBy document", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-checkjson-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    mkdirSync(join(dir, ".nax"), { recursive: true });
    writeFileSync(join(dir, ".nax", "config.json"), "{}");
    mkdirSync(join(dir, "src"), { recursive: true });
    seedStore(iso.gdir, [fixedEntry(dir)]);
    const logs: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (text: string) => {
        logs.push(text);
      },
      error: (_text: string) => {},
    }, async () => {
      const code = await api.trustCheckCommand({ path: join(dir, "src"), json: true });
      expect(code).toBe(0);
      const expected = JSON.stringify({ root: dir, trusted: true, coveredBy: dir }, null, 2);
      expect(logs).toEqual([expected]);
      const parsed = JSON.parse(logs[0] ?? "{}") as { root: string; trusted: boolean; coveredBy: string };
      expect(parsed.root).toBe(dir);
      expect(parsed.trusted).toBe(true);
      expect(parsed.coveredBy).toBe(dir);
    });
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

test("AC-84: trust check on an unparseable store exits 1 naming the parse failure", async () => {
  const api = await cliTrustApi();
  const tmp = tempScope();
  const iso = isolateGlobalDir("nax-trust-checkbad-");
  try {
    const dir = realpathSync(tmp.dir("nax-trust-project-"));
    mkdirSync(iso.gdir, { recursive: true });
    writeFileSync(join(iso.gdir, "trust.json"), "{not json");
    const errors: string[] = [];
    await withDeps(api._cliTrustDeps, {
      log: (_text: string) => {},
      error: (text: string) => {
        errors.push(text);
      },
    }, async () => {
      const code = await api.trustCheckCommand({ path: dir });
      expect(code).toBe(1);
      expect(errors.some((e) => e.includes("trust.json could not be parsed: "))).toBe(true);
    });
  } finally {
    iso.restore();
    tmp.cleanup();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// US-004 — `nax trust` subprocess integration (AC-85, AC-86)
// ═════════════════════════════════════════════════════════════════════════════

test("AC-85: `nax trust check <dir> --json` on an empty store exits 1 with trusted:false", async () => {
  const tmp = tempScope();
  try {
    const dir = realpathSync(tmp.dir("nax-trust-icheck-"));
    const globalDir = tmp.dir("nax-trust-icheck-global-");
    const result = await spawnNax(["trust", "check", dir, "--json"], { globalDir });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { trusted?: boolean };
    expect(parsed.trusted).toBe(false);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

test("AC-86: `nax trust add <dir> --yes` then `nax trust check <dir>` exits 0", async () => {
  const tmp = tempScope();
  try {
    const dir = realpathSync(tmp.dir("nax-trust-iadd-"));
    const globalDir = tmp.dir("nax-trust-iadd-global-");
    const added = await spawnNax(["trust", "add", dir, "--yes"], { globalDir });
    expect(added.exitCode).toBe(0);
    const checked = await spawnNax(["trust", "check", dir], { globalDir });
    expect(checked.exitCode).toBe(0);
  } finally {
    tmp.cleanup();
  }
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
// US-005 — Backstops for imports, hooks and MCP (AC-87..AC-101)
// ═════════════════════════════════════════════════════════════════════════════

test("AC-87: loadPlugins with an untrusted project rejects PROJECT_UNTRUSTED (surface plugins)", async () => {
  const un = await enterUntrusted("nax-trust-plugate-");
  try {
    const project = realpathSync(un.gdir);
    const projectPluginsDir = join(project, ".nax", "plugins");
    mkdirSync(projectPluginsDir, { recursive: true });
    writeFileSync(
      join(projectPluginsDir, "sentinel-plugin.ts"),
      pluginModuleSource("project-sentinel"),
    );
    const emptyGlobalDir = join(project, "empty-global-plugins");
    mkdirSync(emptyGlobalDir, { recursive: true });
    const err = await expectNaxReject(
      loadPlugins(emptyGlobalDir, projectPluginsDir, [], project),
      "PROJECT_UNTRUSTED",
    );
    expect(err.context?.surface).toBe("plugins");
  } finally {
    un.restore();
  }
}, 20_000);

test("AC-88: the sentinel project plugin is never imported (assertion fires first)", async () => {
  const un = await enterUntrusted("nax-trust-plumarker-");
  try {
    const project = realpathSync(un.gdir);
    const projectPluginsDir = join(project, ".nax", "plugins");
    mkdirSync(projectPluginsDir, { recursive: true });
    const marker = join(projectPluginsDir, "sentinel-imported.marker");
    writeFileSync(
      join(projectPluginsDir, "sentinel-plugin.ts"),
      pluginModuleSource("project-sentinel", marker),
    );
    const emptyGlobalDir = join(project, "empty-global-plugins");
    mkdirSync(emptyGlobalDir, { recursive: true });
    await expectNaxReject(
      loadPlugins(emptyGlobalDir, projectPluginsDir, [], project),
      "PROJECT_UNTRUSTED",
    );
    expect(existsSync(marker)).toBe(false);
  } finally {
    un.restore();
  }
}, 20_000);

test("AC-89: the global plugin directory performs no assertTrusted call", async () => {
  const un = await enterUntrusted("nax-trust-pluglobal-");
  try {
    const project = realpathSync(un.gdir);
    const globalPluginsDir = join(project, "global-plugins");
    mkdirSync(globalPluginsDir, { recursive: true });
    writeFileSync(
      join(globalPluginsDir, "global-fixture-plugin.ts"),
      pluginModuleSource("global-trust-fixture"),
    );
    const emptyProjectDir = join(project, "empty-project-plugins");
    const registry = await loadPlugins(globalPluginsDir, emptyProjectDir, [], project);
    expect(registry.plugins.some((p) => p.name === "global-trust-fixture")).toBe(true);
  } finally {
    un.restore();
  }
}, 20_000);

test("AC-90: enabled configPlugins entries are trust-gated even with no discovered plugins", async () => {
  const un = await enterUntrusted("nax-trust-pluconfig-");
  try {
    const project = realpathSync(un.gdir);
    const emptyGlobalDir = join(project, "empty-global-plugins");
    const emptyProjectDir = join(project, "empty-project-plugins");
    await expectNaxReject(
      loadPlugins(emptyGlobalDir, emptyProjectDir, [{ module: "./p.ts" }], project),
      "PROJECT_UNTRUSTED",
    );
  } finally {
    un.restore();
  }
}, 20_000);

test("AC-91: with the project marked trusted, its plugin loads and registers", async () => {
  const un = await enterUntrusted("nax-trust-plutrusted-");
  try {
    const project = realpathSync(un.gdir);
    const projectPluginsDir = join(project, ".nax", "plugins");
    mkdirSync(projectPluginsDir, { recursive: true });
    const marker = join(projectPluginsDir, "project-imported.marker");
    writeFileSync(
      join(projectPluginsDir, "project-plugin.ts"),
      pluginModuleSource("project-trust-fixture", marker),
    );
    const emptyGlobalDir = join(project, "empty-global-plugins");
    mkdirSync(emptyGlobalDir, { recursive: true });
    un.t.markTrusted(project);
    const registry = await loadPlugins(emptyGlobalDir, projectPluginsDir, [], project);
    expect(registry.plugins.some((p) => p.name === "project-trust-fixture")).toBe(true);
    expect(existsSync(marker)).toBe(true);
  } finally {
    un.restore();
  }
}, 20_000);

test("AC-92: loadPluginProviders rejects PROJECT_UNTRUSTED (surface context-plugin-providers)", async () => {
  const un = await enterUntrusted("nax-trust-prov-");
  try {
    const project = realpathSync(un.gdir);
    const err = await expectNaxReject(
      loadPluginProviders([{ module: "./prov.ts", enabled: true }], project),
      "PROJECT_UNTRUSTED",
    );
    expect(err.context?.surface).toBe("context-plugin-providers");
  } finally {
    un.restore();
  }
});

test("AC-93: the provider trust assertion fires before any dynamic import", async () => {
  const un = await enterUntrusted("nax-trust-provimport-");
  try {
    const project = realpathSync(un.gdir);
    const importSpy = mock(async () => {
      throw new Error("dynamic import must not run");
    });
    await withDeps(_pluginLoaderDeps, { dynamicImport: importSpy }, async () => {
      await expectNaxReject(
        loadPluginProviders([{ module: "./prov.ts", enabled: true }], project),
        "PROJECT_UNTRUSTED",
      );
      expect(importSpy).toHaveBeenCalledTimes(0);
    });
  } finally {
    un.restore();
  }
});

test("AC-94: disabled provider entries hit the early return before the trust assertion", async () => {
  const un = await enterUntrusted("nax-trust-provoff-");
  try {
    const project = realpathSync(un.gdir);
    const importSpy = mock(async () => {
      throw new Error("dynamic import must not run");
    });
    await withDeps(_pluginLoaderDeps, { dynamicImport: importSpy }, async () => {
      const providers = await loadPluginProviders([{ module: "./prov.ts", enabled: false }], project);
      expect(providers).toHaveLength(0);
      expect(importSpy).toHaveBeenCalledTimes(0);
    });
  } finally {
    un.restore();
  }
});

test("AC-95: an untrusted project hook rejects PROJECT_UNTRUSTED (surface hooks)", async () => {
  const un = await enterUntrusted("nax-trust-hook-");
  try {
    const project = realpathSync(un.gdir);
    const marker = join(project, "hook-ran.marker");
    const config = {
      hooks: { "on-start": { command: `touch ${marker}` } },
    } as LoadedHooksConfig;
    const ctx: HookContext = { event: "on-start", feature: "demo" };
    const err = await expectNaxReject(fireHook(config, "on-start", ctx, project), "PROJECT_UNTRUSTED");
    expect(err.context?.surface).toBe("hooks");
  } finally {
    un.restore();
  }
}, 20_000);

test("AC-96: the project hook process is never spawned (assertion before the hook try block)", async () => {
  const un = await enterUntrusted("nax-trust-hookmarker-");
  try {
    const project = realpathSync(un.gdir);
    const marker = join(project, "hook-ran.marker");
    const config = {
      hooks: { "on-start": { command: `touch ${marker}` } },
    } as LoadedHooksConfig;
    const ctx: HookContext = { event: "on-start", feature: "demo" };
    await expectNaxReject(fireHook(config, "on-start", ctx, project), "PROJECT_UNTRUSTED");
    expect(existsSync(marker)).toBe(false);
  } finally {
    un.restore();
  }
}, 20_000);

test("AC-97: a global-only hook fires without requiring project trust", async () => {
  const un = await enterUntrusted("nax-trust-hookglobal-");
  try {
    const project = realpathSync(un.gdir);
    const globalMarker = join(project, "global-hook-ran.marker");
    const config = {
      hooks: {},
      _global: { hooks: { "on-start": { command: `touch ${globalMarker}` } } },
    } as LoadedHooksConfig;
    const ctx: HookContext = { event: "on-start", feature: "demo" };
    await fireHook(config, "on-start", ctx, project);
    expect(existsSync(globalMarker)).toBe(true);
  } finally {
    un.restore();
  }
}, 20_000);

test("AC-98: the MCP pool's listTools rejects PROJECT_UNTRUSTED (surface mcp)", async () => {
  const un = await enterUntrusted("nax-trust-mcp-");
  try {
    const project = realpathSync(un.gdir);
    const transportSpy = mock(() => {
      throw new Error("transport must not be created");
    });
    await withDeps(_mcpClientDeps, { createTransport: transportSpy }, async () => {
      const stdioServer = { command: "echo", args: ["hi"], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true };
      const servers = { s: stdioServer } as Parameters<typeof createMcpPool>[0]["servers"];
      const pool = createMcpPool({ servers });
      const err = await expectNaxReject(pool.listTools("s", project), "PROJECT_UNTRUSTED");
      expect(err.context?.surface).toBe("mcp");
    });
  } finally {
    un.restore();
  }
}, 20_000);

test("AC-99: the MCP trust assertion fires before any transport is created", async () => {
  const un = await enterUntrusted("nax-trust-mcptransport-");
  try {
    const project = realpathSync(un.gdir);
    const transportSpy = mock(() => {
      throw new Error("transport must not be created");
    });
    await withDeps(_mcpClientDeps, { createTransport: transportSpy }, async () => {
      const stdioServer = { command: "echo", args: ["hi"], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true };
      const servers = { s: stdioServer } as Parameters<typeof createMcpPool>[0]["servers"];
      const pool = createMcpPool({ servers });
      await expectNaxReject(pool.listTools("s", project), "PROJECT_UNTRUSTED");
      expect(transportSpy).toHaveBeenCalledTimes(0);
    });
  } finally {
    un.restore();
  }
}, 20_000);

test("AC-100: the MCP pool's call rejects PROJECT_UNTRUSTED rather than error-as-data", async () => {
  const un = await enterUntrusted("nax-trust-mcpcall-");
  try {
    const project = realpathSync(un.gdir);
    const transportSpy = mock(() => {
      throw new Error("transport must not be created");
    });
    await withDeps(_mcpClientDeps, { createTransport: transportSpy }, async () => {
      const stdioServer = { command: "echo", args: ["hi"], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true };
      const servers = { s: stdioServer } as Parameters<typeof createMcpPool>[0]["servers"];
      const pool = createMcpPool({ servers });
      await expectNaxReject(
        pool.call("s", project, "t", {}, { timeoutMs: 1000, maxBytes: 1000 }),
        "PROJECT_UNTRUSTED",
      );
    });
  } finally {
    un.restore();
  }
}, 20_000);

test("AC-101: with the project trusted, one listTools connect creates exactly one transport", async () => {
  const un = await enterUntrusted("nax-trust-mcptrusted-");
  try {
    const project = realpathSync(un.gdir);
    un.t.markTrusted(project);
    const transportSpy = mock(() => ({ pid: 4242, close: async () => {} }));
    const fakeClient = {
      connect: async () => {},
      listTools: async () => ({ tools: [{ name: "t", description: "d", inputSchema: {} }] }),
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      close: async () => {},
    };
    await withDeps(_mcpClientDeps, {
      createTransport: transportSpy,
      createClient: mock(() => fakeClient),
    }, async () => {
      const stdioServer = { command: "echo", args: ["hi"], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true };
      const servers = { s: stdioServer } as Parameters<typeof createMcpPool>[0]["servers"];
      const pool = createMcpPool({ servers });
      const tools = await pool.listTools("s", project);
      expect(tools.map((tool) => tool.name)).toContain("t");
      expect(transportSpy).toHaveBeenCalledTimes(1);
    });
  } finally {
    un.restore();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// US-006 — Backstops for command spawns and the sandbox deny (AC-102..AC-116)
// ═════════════════════════════════════════════════════════════════════════════

test("AC-102: runQualityCommand rejects PROJECT_UNTRUSTED (surface quality-command)", async () => {
  const un = await enterUntrusted("nax-trust-quality-");
  try {
    const project = realpathSync(un.gdir);
    const err = await expectNaxReject(
      runQualityCommand({ commandName: "test", command: "echo hi", workdir: project }),
      "PROJECT_UNTRUSTED",
    );
    expect(err.context?.surface).toBe("quality-command");
  } finally {
    un.restore();
  }
});

test("AC-103: the quality-command rejection happens before any spawn", async () => {
  const un = await enterUntrusted("nax-trust-qualityspawn-");
  try {
    const project = realpathSync(un.gdir);
    const spawnSpy = mock(() => {
      throw new Error("spawn must not run");
    });
    await withDeps(_qualityRunnerDeps, { spawn: spawnSpy }, async () => {
      await expectNaxReject(
        runQualityCommand({ commandName: "test", command: "echo hi", workdir: project }),
        "PROJECT_UNTRUSTED",
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  } finally {
    un.restore();
  }
});

test("AC-104: executeWithTimeout rejects PROJECT_UNTRUSTED (surface test-command)", async () => {
  const un = await enterUntrusted("nax-trust-exec-");
  try {
    const project = realpathSync(un.gdir);
    const err = await expectNaxReject(
      executeWithTimeout("echo hi", 5, undefined, { cwd: project }),
      "PROJECT_UNTRUSTED",
    );
    expect(err.context?.surface).toBe("test-command");
  } finally {
    un.restore();
  }
});

test("AC-105: the executeWithTimeout rejection happens before any spawn", async () => {
  const un = await enterUntrusted("nax-trust-execspawn-");
  try {
    const project = realpathSync(un.gdir);
    const spawnSpy = mock(() => {
      throw new Error("spawn must not run");
    });
    await withDeps(_executorDeps, { spawn: spawnSpy }, async () => {
      await expectNaxReject(executeWithTimeout("echo hi", 5, undefined, { cwd: project }), "PROJECT_UNTRUSTED");
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  } finally {
    un.restore();
  }
});

test("AC-106: executeWithTimeout without options asserts against resolve('.') and never spawns", async () => {
  const un = await enterUntrusted("nax-trust-execnocwd-");
  try {
    const spawnSpy = mock(() => {
      throw new Error("spawn must not run");
    });
    await withDeps(_executorDeps, { spawn: spawnSpy }, async () => {
      await expectNaxReject(executeWithTimeout("echo hi", 5), "PROJECT_UNTRUSTED");
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  } finally {
    un.restore();
  }
});

test("AC-107: runHardeningPass on an untrusted project resolves to an empty result", async () => {
  const un = await enterUntrusted("nax-trust-hardening-");
  try {
    const project = realpathSync(un.gdir);
    const ctx = {
      prd: {
        feature: "demo",
        userStories: [{ id: "US-001", title: "story", suggestedCriteria: ["Does the thing"] }],
      },
      prdPath: join(project, "prd.json"),
      featureDir: join(project, ".nax", "features", "demo"),
      workdir: project,
      config: {},
      runtime: {},
      agentManager: {},
      sessionManager: {},
      abortSignal: new AbortController().signal,
    } as unknown as HardeningContext;
    await withDeps(_hardeningDeps, {
      callOp: mock(async () => {
        throw new Error("callOp must not run");
      }),
      savePRD: mock(async () => {}),
      detectLanguage: mock(async () => undefined),
      spawn: mock(() => {
        throw new Error("spawn must not run");
      }),
    }, async () => {
      const result = await runHardeningPass(ctx);
      expect(result).toEqual({ promoted: [], discarded: [] });
    });
  } finally {
    un.restore();
  }
});

test("AC-108: the hardening rejection prevents any LLM call", async () => {
  const un = await enterUntrusted("nax-trust-hardcall-");
  try {
    const project = realpathSync(un.gdir);
    const ctx = {
      prd: {
        feature: "demo",
        userStories: [{ id: "US-001", title: "story", suggestedCriteria: ["Does the thing"] }],
      },
      prdPath: join(project, "prd.json"),
      featureDir: join(project, ".nax", "features", "demo"),
      workdir: project,
      config: {},
      runtime: {},
      agentManager: {},
      sessionManager: {},
      abortSignal: new AbortController().signal,
    } as unknown as HardeningContext;
    const callOpSpy = mock(async () => {
      throw new Error("callOp must not run");
    });
    await withDeps(_hardeningDeps, {
      callOp: callOpSpy,
      savePRD: mock(async () => {}),
      detectLanguage: mock(async () => undefined),
      spawn: mock(() => {
        throw new Error("spawn must not run");
      }),
    }, async () => {
      await runHardeningPass(ctx);
      expect(callOpSpy).not.toHaveBeenCalled();
    });
  } finally {
    un.restore();
  }
});

test("AC-109: the hardening rejection prevents any test-command spawn", async () => {
  const un = await enterUntrusted("nax-trust-hardspawn-");
  try {
    const project = realpathSync(un.gdir);
    const ctx = {
      prd: {
        feature: "demo",
        userStories: [{ id: "US-001", title: "story", suggestedCriteria: ["Does the thing"] }],
      },
      prdPath: join(project, "prd.json"),
      featureDir: join(project, ".nax", "features", "demo"),
      workdir: project,
      config: {},
      runtime: {},
      agentManager: {},
      sessionManager: {},
      abortSignal: new AbortController().signal,
    } as unknown as HardeningContext;
    const spawnSpy = mock(() => {
      throw new Error("spawn must not run");
    });
    await withDeps(_hardeningDeps, {
      callOp: mock(async () => {
        throw new Error("callOp must not run");
      }),
      savePRD: mock(async () => {}),
      detectLanguage: mock(async () => undefined),
      spawn: spawnSpy,
    }, async () => {
      await runHardeningPass(ctx);
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  } finally {
    un.restore();
  }
});

test("AC-110: maybeRunNewPackageSetup rejects PROJECT_UNTRUSTED (surface package-setup)", async () => {
  const un = await enterUntrusted("nax-trust-pkgsetup-");
  try {
    const project = realpathSync(un.gdir);
    const runtime: object = {};
    const packageDir = join(project, "pkg");
    markNewPackageDirs(runtime, [packageDir]);
    const err = await expectNaxReject(
      maybeRunNewPackageSetup({ runtime, storyId: "US-001", packageDir, setupCommand: "echo hi" }),
      "PROJECT_UNTRUSTED",
    );
    expect(err.context?.surface).toBe("package-setup");
  } finally {
    un.restore();
  }
});

test("AC-111: the package-setup rejection happens before any spawn", async () => {
  const un = await enterUntrusted("nax-trust-pkgspawn-");
  try {
    const project = realpathSync(un.gdir);
    const runtime: object = {};
    const packageDir = join(project, "pkg");
    markNewPackageDirs(runtime, [packageDir]);
    const spawnSpy = mock(() => {
      throw new Error("spawn must not run");
    });
    await withDeps(_newPackageSetupDeps, { spawn: spawnSpy }, async () => {
      await expectNaxReject(
        maybeRunNewPackageSetup({ runtime, storyId: "US-001", packageDir, setupCommand: "echo hi" }),
        "PROJECT_UNTRUSTED",
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  } finally {
    un.restore();
  }
});

test("AC-112: prepareWorktreeDependencies rejects PROJECT_UNTRUSTED (surface worktree-setup)", async () => {
  const un = await enterUntrusted("nax-trust-wtdeps-");
  try {
    const project = realpathSync(un.gdir);
    const worktreeRoot = join(project, ".nax-wt", "w1");
    mkdirSync(worktreeRoot, { recursive: true });
    const worktreeReal = realpathSync(worktreeRoot);
    const config = {
      execution: {
        worktreeDependencies: { mode: "provision", setupCommand: "echo hi", timeoutSeconds: 10 },
      },
    } as unknown as NaxConfig;
    const err = await expectNaxReject(
      prepareWorktreeDependencies({ projectRoot: project, worktreeRoot: worktreeReal, storyId: "US-001", config }),
      "PROJECT_UNTRUSTED",
    );
    expect(err.context?.surface).toBe("worktree-setup");
  } finally {
    un.restore();
  }
});

test("AC-113: the worktree-setup rejection happens before any spawn", async () => {
  const un = await enterUntrusted("nax-trust-wtspawn-");
  try {
    const project = realpathSync(un.gdir);
    const worktreeRoot = join(project, ".nax-wt", "w1");
    mkdirSync(worktreeRoot, { recursive: true });
    const worktreeReal = realpathSync(worktreeRoot);
    const config = {
      execution: {
        worktreeDependencies: { mode: "provision", setupCommand: "echo hi", timeoutSeconds: 10 },
      },
    } as unknown as NaxConfig;
    const spawnSpy = mock(() => {
      throw new Error("spawn must not run");
    });
    await withDeps(_worktreeDependencyDeps, { spawn: spawnSpy }, async () => {
      await expectNaxReject(
        prepareWorktreeDependencies({ projectRoot: project, worktreeRoot: worktreeReal, storyId: "US-001", config }),
        "PROJECT_UNTRUSTED",
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  } finally {
    un.restore();
  }
});

test("AC-114: buildSandboxPolicy adds trustStoreFile to denyWrite like approvalsFile", () => {
  const tmp = tempScope();
  try {
    const root = realpathSync(tmp.dir("nax-trust-sbx-"));
    const home = realpathSync(tmp.dir("nax-trust-sbxhome-"));
    const trustStoreFile = join(home, ".nax", "trust.json");
    const config = SandboxConfigSchema.parse({ filesystem: { allowWrite: ["~/.nax"] } });
    const policy = buildSandboxPolicy({
      root,
      git: { kind: "none" },
      gitGuardFiles: [],
      naxEntries: [],
      credentialFiles: [],
      trustStoreFile,
      home,
      tempRoots: ["/tmp"],
      platform: "linux",
      config,
    } as Parameters<typeof buildSandboxPolicy>[0]);
    expect(policy.denyWrite).toContain(trustStoreFile);
  } finally {
    tmp.cleanup();
  }
});

test("AC-115: without trustStoreFile every denyWrite entry is a real string", () => {
  const tmp = tempScope();
  try {
    const root = realpathSync(tmp.dir("nax-trust-sbxnone-"));
    const home = realpathSync(tmp.dir("nax-trust-sbxhomenone-"));
    const config = SandboxConfigSchema.parse({});
    const policy = buildSandboxPolicy({
      root,
      git: { kind: "none" },
      gitGuardFiles: [],
      naxEntries: [],
      credentialFiles: [],
      home,
      tempRoots: ["/tmp"],
      platform: "linux",
      config,
    });
    expect(Array.isArray(policy.denyWrite)).toBe(true);
    expect(policy.denyWrite.every((entry) => entry != null)).toBe(true);
    expect(policy.denyWrite.some((entry) => entry.includes("trust.json"))).toBe(false);
  } finally {
    tmp.cleanup();
  }
});

test("AC-116: the session sandbox policy denies writes to the real trust store path", async () => {
  const un = await enterUntrusted("nax-trust-sbxsession-");
  try {
    const { trustStorePath } = un.t;
    const root = realpathSync(un.gdir);
    const backend = makeRecordingFakeBackend();
    const saved = { ..._sessionSandboxDeps };
    Object.assign(_sessionSandboxDeps, {
      backendFor: () => backend,
      probe: async () => ({ available: true as const }),
      gitLayout: async () => ({ kind: "none" as const }),
      naxEntries: async (): Promise<string[]> => [],
      gitGuardFiles: async (): Promise<string[]> => [],
      credentialFiles: async (): Promise<string[]> => [],
      commonDirTripwire: async () => undefined,
      homedir: () => root,
      platform: (): NodeJS.Platform => "linux",
      tempRoots: () => ["/tmp"],
      tmpdir: () => "/tmp",
      mkdir: async () => undefined,
      runTempRoots: ({ runTmpRoot }: { runTmpRoot: string }) => [runTmpRoot],
    });
    try {
      const config = SandboxConfigSchema.parse({ enabled: true });
      const launcher = await resolveSessionSandbox({ config, root, needsLauncher: true });
      await launcher.run({
        spec: { kind: "shell", shell: "/bin/sh", command: "true" },
        root,
        cwd: root,
        timeoutMs: 10_000,
        stripEnvVars: [],
      });
      expect(backend.calls.length).toBeGreaterThan(0);
      const recordedPolicy = backend.calls[0]?.policy;
      expect(recordedPolicy).toBeDefined();
      expect(recordedPolicy?.denyWrite).toContain(realOrRaw(trustStorePath()));
    } finally {
      Object.assign(_sessionSandboxDeps, saved);
    }
  } finally {
    un.restore();
  }
}, 20_000);