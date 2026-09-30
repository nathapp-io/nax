/**
 * Shared stub for the `_sessionSandboxDeps` seam
 * (`src/agents/coding-tool-sandbox.ts`).
 *
 * US-002 adds three dependencies to that seam — `mkdir`, `tmpdir` and
 * `runTempRoots` — so a test that pins the confined run-temp-root decision has
 * to control the backend, the probe, the temp roots AND the mkdir outcome at
 * the same time. That setup lives here instead of being copy-pasted per file.
 *
 * The deps object is PASSED IN rather than imported, for the same reason
 * `session-tmp-deps.ts` takes it as a parameter: `test/helpers/index.ts` is
 * loaded by almost every suite, so a static import of a src export that does
 * not exist yet would fail those suites at module load instead of failing the
 * one test that actually needs the seam.
 */
import { afterEach, beforeEach } from "bun:test";
import type { SandboxConfig } from "@/config/schemas-sandbox";
import type { GitLayout, ProbeResult, SandboxBackend } from "@/sandbox";
import { makeFakeSandboxBackend } from "./sandbox";

/** The `{ runTmpRoot, tmpdir }` argument US-002's `runTempRoots` takes. */
export interface RunTempRootsArgs {
  readonly runTmpRoot: string;
  readonly tmpdir: string;
}

/**
 * The `_sessionSandboxDeps` members a confined-session test drives. Only the
 * members a stub replaces are named; every other key of the real object is
 * untouched.
 */
export interface SessionSandboxDepsLike {
  backendFor(config: SandboxConfig): SandboxBackend;
  probe(backend: SandboxBackend, storyId?: string): Promise<ProbeResult>;
  gitLayout(root: string): Promise<GitLayout>;
  naxEntries(root: string): Promise<string[]>;
  gitGuardFiles(git: GitLayout): Promise<string[]>;
  credentialFiles(): Promise<string[]>;
  tempRoots(): string[];
  homedir(): string;
  platform(): NodeJS.Platform;
  /**
   * US-002 — creates the session temp dir before the policy is built. Returns
   * `unknown`, not `Promise<void>`: `node:fs`'s recursive `mkdir` resolves with
   * the created path, and a synchronous implementation is equally valid, so the
   * seam must accept either.
   */
  mkdir(path: string): unknown;
  /** US-002 — `os.tmpdir()`. */
  tmpdir(): string;
  /** US-002 — the temp roots for one run, given its own root. */
  runTempRoots(opts: RunTempRootsArgs): string[];
}

/** A temp dir that is NOT under `/tmp`, so `runTempRoots` keeps it. */
export const NON_SHARED_TMPDIR = "/var/folders/x/T";

/** The marker `events` carries each time a policy is built. */
export const POLICY_BUILT = "policy";

export interface ConfinedSessionOptions {
  /** What `tempRoots()` returns — in production `defaultTempRoots()`. Defaults to `["/tmp"]`. */
  readonly tempRoots?: readonly string[];
  /** What `tmpdir()` returns. Defaults to a temp dir outside `/tmp`. */
  readonly tmpdir?: string;
  /**
   * `"ok"` records the call and succeeds, `"fails"` rejects the way an unwritable
   * temp root does, and `"real"` records the call AND delegates to the production
   * `mkdir` — the mode a filesystem-level assertion needs, where the directory
   * under test must actually appear on disk.
   */
  readonly mkdir?: "ok" | "fails" | "real";
  /** What `homedir()` returns. Defaults to a path that exists nowhere. */
  readonly homedir?: string;
  /** What `platform()` returns. Defaults to `"linux"`, so a test never depends on the host OS. */
  readonly platform?: NodeJS.Platform;
}

/** The backend double, with the wrap requests it recorded. */
export type FakeSandboxBackend = ReturnType<typeof makeFakeSandboxBackend>;

export interface ConfinedSessionSeam {
  /** The double `backendFor` hands back; `backend.calls[0]?.policy` is what `wrap` received. */
  readonly backend: FakeSandboxBackend;
  /** Every path `mkdir` was called with, in order. */
  readonly mkdirCalls: readonly string[];
  /** Every argument `runTempRoots` was called with, in order. */
  readonly runTempRootCalls: readonly RunTempRootsArgs[];
  /** Ordered markers: `mkdir:<path>`, `runTempRoots:<root>` and {@link POLICY_BUILT}. */
  readonly events: readonly string[];
}

/**
 * Mirrors the `runTempRoots` contract: a tmpdir that is `/tmp`, `/private/tmp`
 * or under either is never added back, because adding it would re-grant the
 * whole shared temp directory the confinement exists to remove.
 */
function runTempRootsFor({ runTmpRoot }: RunTempRootsArgs, tmpdir: string): string[] {
  const shared =
    tmpdir === "/tmp" || tmpdir === "/private/tmp" || tmpdir.startsWith("/tmp/") || tmpdir.startsWith("/private/tmp/");
  return shared ? [runTmpRoot] : [tmpdir, runTmpRoot];
}

/**
 * Point `deps` at an available, stubbed sandbox and return the recorders.
 *
 * Pair with `withDepsRestore(_sessionSandboxDeps)` in the enclosing `describe`
 * so the production values come back afterwards.
 */
export function stubSessionSandboxDeps(
  deps: SessionSandboxDepsLike,
  options: ConfinedSessionOptions = {},
): ConfinedSessionSeam {
  const backend = makeFakeSandboxBackend();
  const mkdirCalls: string[] = [];
  const runTempRootCalls: RunTempRootsArgs[] = [];
  const events: string[] = [];
  const tmpdir = options.tmpdir ?? NON_SHARED_TMPDIR;
  const tempRoots = [...(options.tempRoots ?? ["/tmp"])];

  deps.backendFor = () => backend;
  deps.probe = async () => ({ available: true });
  deps.gitLayout = async () => ({ kind: "none" });
  deps.gitGuardFiles = async () => [];
  deps.naxEntries = async () => {
    events.push(POLICY_BUILT);
    return [];
  };
  deps.credentialFiles = async () => [];
  deps.homedir = () => options.homedir ?? "/nonexistent-nax-test-home";
  deps.platform = () => options.platform ?? "linux";
  deps.tempRoots = () => [...tempRoots];
  deps.tmpdir = () => tmpdir;
  // Captured before the overwrite, so `mkdir: "real"` still reaches the
  // production recursive mkdir the seam ships with.
  const realMkdir = deps.mkdir;
  deps.mkdir = async (path: string): Promise<void> => {
    events.push(`mkdir:${path}`);
    mkdirCalls.push(path);
    if (options.mkdir === "fails") throw new Error("EXDEV: cross-device link");
    if (options.mkdir === "real") await realMkdir(path);
  };
  deps.runTempRoots = (opts) => {
    events.push(`runTempRoots:${opts.runTmpRoot}`);
    runTempRootCalls.push({ ...opts });
    return runTempRootsFor(opts, tmpdir);
  };

  return { backend, mkdirCalls, runTempRootCalls, events };
}

/** The `_sessionSandboxDeps` keys US-002 adds to the seam. */
const US002_KEYS = ["mkdir", "tmpdir", "runTempRoots"];

/**
 * Register the seam's save/restore lifecycle inside a `describe` body, pairing
 * with `withDepsRestore(_sessionSandboxDeps)`.
 *
 * `withDepsRestore` only restores keys the object already had, which is right
 * for the production shape but leaves the US-002 stubs behind while the
 * implementation is still missing them: every later file in the same `bun test`
 * process would inherit a stubbed `mkdir`/`tmpdir`/`runTempRoots`. This removes
 * exactly the keys that were absent before the test.
 */
export function withSessionSandboxSeam(deps: object): void {
  let absentBeforeTest: readonly string[] = [];
  beforeEach(() => {
    absentBeforeTest = US002_KEYS.filter((key) => !(key in deps));
  });
  afterEach(() => {
    for (const key of absentBeforeTest) Reflect.deleteProperty(deps, key);
  });
}
