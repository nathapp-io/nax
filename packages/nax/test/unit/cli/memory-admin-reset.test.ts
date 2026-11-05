/**
 * US-011 — `nax memory reset`: rebuild the koda project mirror.
 *
 * Every case drives `memoryResetCommand` (or the program `registerMemoryCommand` builds) with the
 * two seams a reset acts through stubbed — `_memoryAdminDeps` for the mirror's entries, and
 * `deps.createMemoryHost` for the host whose `status()` and `sync()` it reads — and the mirror
 * itself held in memory, so what is pinned is which entries were removed and in what order, which
 * file survived with which bytes, what reached each output channel, and the code the outcome
 * became.
 *
 * One case reads a real directory instead: the approvals file's survival is a promise about
 * bytes on disk, and an in-memory map would only prove the intent.
 *
 * The sync lines are spelled out in full rather than compared against the formatter that produced
 * them, so a line that both the command and the formatter got wrong still fails here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { MemorySyncResult } from "@nathapp/nax-agent";
import { assertDefined, makeNaxConfig, realAdminDeps, withTempDir } from "@test/helpers";
import { Command } from "commander";
import {
  _memoryAdminDeps,
  type MemoryCliDeps,
  memoryResetCommand,
  memorySyncCommand,
  registerMemoryCommand,
} from "@/cli";
import type { CreateMemoryHostInput, MemoryDirs, MemoryHost } from "@/memory";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The directory `--dir` names in every stubbed case. */
const REPO_DIR = "/repo";

/** The provider id a linked koda host reports, and one a reset must refuse. */
const KODA_PROVIDER = "koda:rs-stock";
const LOCAL_PROVIDER = "local";

/** The mirror locations the host resolves. */
const MEMORY_ROOT = "/mirror";
const PROJECT_DIR = join(MEMORY_ROOT, "projects", "repo-abc12345");
const USER_DIR = join(MEMORY_ROOT, "user");

/** The one entry a reset leaves in the project mirror, and the bytes it must keep. */
const APPROVALS_PATH = join(PROJECT_DIR, "koda-approvals.json");
const APPROVALS_BYTES =
  '{"version":1,"approvals":[{"approvalId":"apr_1","scope":"project","slug":"replay-budget","clientId":"c_9"}]}\n';

/** The entries a reset removes: the notes, the outbox and the export cursor. */
const NOTE_PATH = join(PROJECT_DIR, "notes", "staging-db.md");
const OUTBOX_PATH = join(PROJECT_DIR, "outbox.jsonl");
const CURSOR_PATH = join(PROJECT_DIR, "sync.json");

/** The machine's own note: the mirror a reset must never touch. */
const USER_NOTE_PATH = join(USER_DIR, "pref.md");
const USER_NOTE_BODY = "the body of pref\n";

const DEFAULT_DIRS: MemoryDirs = { root: MEMORY_ROOT, projectDir: PROJECT_DIR, userDir: USER_DIR };

/** A run that moved everything it had: the only outcome a reset reports as a success. */
const SYNCED: MemorySyncResult = { outcome: "synced", pushed: 1, rejected: 0, pulled: 2, skipped: 0 };
/** The line a synced run prints, spelled out. */
const SYNCED_LINE = "memory sync: synced (pushed 1, rejected 0, pulled 2, skipped 0)";
/** A provider that could not be reached: the rebuild pulled nothing. */
const UNREACHABLE: MemorySyncResult = { outcome: "unreachable", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };
/** Another writer held the lock: the next sync will try again. */
const LOCKED: MemorySyncResult = { outcome: "locked", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };
/** A run that ended in an error, with the message it ended on. */
const FAILED: MemorySyncResult = {
  outcome: "failed",
  pushed: 0,
  rejected: 0,
  pulled: 0,
  skipped: 0,
  error: "lock busy",
};

/** The two counts the host's `status()` reports, and nothing else a reset reads from it. */
interface HostCounts {
  readonly queued: number;
  readonly rejected: number;
}

/** What one case varies: the provider, the undelivered counts, the sync, and the seams. */
interface ResetFixture {
  readonly providerId?: string;
  readonly counts?: HostCounts;
  readonly result?: MemorySyncResult;
  /** A mirror that is switched off: `createMemoryHost` answers `null`. */
  readonly disabled?: boolean;
  /** The mirror locations the host resolves; the default is the `/mirror` fixture. */
  readonly dirs?: MemoryDirs;
  /** Filesystem members installed over the recorders, for a case that drives a real directory. */
  readonly fs?: Partial<typeof _memoryAdminDeps>;
}

/** The mirror's entries, in listing order: the approvals first, then what a reset removes. */
function mirrorEntries(): Map<string, string> {
  const files = new Map<string, string>();
  files.set(APPROVALS_PATH, APPROVALS_BYTES);
  files.set(NOTE_PATH, "the body of staging-db\n");
  files.set(OUTBOX_PATH, "");
  files.set(CURSOR_PATH, '{"lastPullAt":null}\n');
  files.set(USER_NOTE_PATH, USER_NOTE_BODY);
  return files;
}

/** The entry names one directory of `files` holds, as `listDir` answers for it. */
function namesUnder(files: ReadonlyMap<string, string>, path: string): readonly string[] {
  const prefix = `${path}/`;
  return [
    ...new Set(
      [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length).split("/")[0]),
    ),
  ].filter((name): name is string => name !== undefined);
}

/** The stubbed CLI one case drives, and everything it recorded. */
interface ResetHarness {
  readonly deps: MemoryCliDeps;
  /** The mirror's files, keyed by path. */
  readonly files: Map<string, string>;
  /** stdout lines. */
  readonly out: string[];
  /** stderr lines. */
  readonly err: string[];
  /** Every code handed to `exit`, in order. */
  readonly codes: number[];
  /** Every path `removePath` was called with, in order. */
  readonly removed: string[];
  /** Every path `listDir` was called with, in order. */
  readonly listed: string[];
  /** `list <path>`, `remove <path>` and `sync`, in the order they happened. */
  readonly events: string[];
  /** What each `createMemoryHost` call was given. */
  readonly hostCalls: CreateMemoryHostInput[];
}

/**
 * The host a reset opens: `dirs`, `providerId`, `status()` and `sync()` carry the case, and every
 * other member throws, so a case that reads one is told which member it reached.
 */
function resetHost(fix: ResetFixture, events: string[]): MemoryHost {
  const unread = async (): Promise<never> => {
    throw new Error("a reset reads only dirs, providerId, status and sync");
  };
  const provider = fix.providerId ?? KODA_PROVIDER;
  const counts = fix.counts ?? { queued: 0, rejected: 0 };
  const result = fix.result ?? SYNCED;
  const dirs = fix.dirs ?? DEFAULT_DIRS;
  return {
    dirs,
    providerId: provider,
    writeMode: "direct",
    notes: unread,
    getNote: unread,
    search: unread,
    renderIndex: unread,
    sync: async () => {
      events.push("sync");
      return result;
    },
    status: async () => ({
      enabled: true,
      provider,
      writeMode: "direct",
      projectDir: dirs.projectDir,
      userDir: dirs.userDir,
      lastPullAt: null,
      lastError: null,
      queued: counts.queued,
      rejected: counts.rejected,
      rejectedEntries: [],
      notes: { project: 0, user: 0, repo: 0 },
      repoSkipped: 0,
    }),
    save: unread,
    forget: unread,
    approve: unread,
  };
}

/** The CLI with every seam a reset acts through stubbed. */
function makeResetHarness(fix: ResetFixture = {}): ResetHarness {
  const files = mirrorEntries();
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const removed: string[] = [];
  const listed: string[] = [];
  const events: string[] = [];
  const hostCalls: CreateMemoryHostInput[] = [];
  _memoryAdminDeps.listDir = async (path) => {
    listed.push(path);
    events.push(`list ${path}`);
    return namesUnder(files, path);
  };
  _memoryAdminDeps.removePath = async (path) => {
    removed.push(path);
    events.push(`remove ${path}`);
    // A removal takes the tree with it.
    for (const key of [...files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) files.delete(key);
    }
  };
  Object.assign(_memoryAdminDeps, fix.fs ?? {});
  const deps: MemoryCliDeps = {
    log: (msg) => out.push(msg),
    logErr: (msg) => err.push(msg),
    exit: (code) => codes.push(code),
    findProjectDir: () => null,
    loadConfig: async () => makeNaxConfig(),
    createMemoryHost: async (input) => {
      hostCalls.push(input);
      return fix.disabled === true ? null : resetHost(fix, events);
    },
    readFile: async () => "",
  };
  return { deps, files, out, err, codes, removed, listed, events, hostCalls };
}

/** One reset through the command function, as the operator's flags reach it. */
async function runReset(h: ResetHarness, extra: { readonly json?: boolean } = {}): Promise<number> {
  return await memoryResetCommand({ dir: REPO_DIR, ...extra }, h.deps);
}

let savedAdminDeps: typeof _memoryAdminDeps = { ..._memoryAdminDeps };

beforeEach(() => {
  savedAdminDeps = { ..._memoryAdminDeps };
});

afterEach(() => {
  Object.assign(_memoryAdminDeps, savedAdminDeps);
});

// ─── the guards ──────────────────────────────────────────────────────────────

describe("nax memory reset — what it refuses", () => {
  test("AC-1: a provider that is not koda is refused, naming the mirror that holds the only copy", async () => {
    const h = makeResetHarness({ providerId: LOCAL_PROVIDER });

    expect(await runReset(h)).toBe(1);
    expect(h.err).toEqual([
      '[memory] reset needs memory.provider "koda": the local mirror is the only copy of its notes',
    ]);
    expect(h.removed).toEqual([]);
    expect(h.listed).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.out).toEqual([]);
  });

  test("AC-2: writes the provider has not delivered refuse the reset, and nothing is removed", async () => {
    const h = makeResetHarness({ counts: { queued: 1, rejected: 1 } });

    expect(await runReset(h)).toBe(1);
    expect(h.err).toEqual([
      "[memory] 2 writes are not delivered; run nax memory sync (or nax memory forget) before reset",
    ]);
    expect(h.removed).toEqual([]);
    expect(h.listed).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.files.has(CURSOR_PATH)).toBe(true);
  });

  test("AC-3: memory disabled prints the group's error and exits as nax memory sync does", async () => {
    const h = makeResetHarness({ disabled: true });

    expect(await runReset(h)).toBe(1);
    expect(h.err).toEqual(["Error: memory is disabled (memory.enabled is false)"]);
    expect(h.out).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.events).toEqual([]);

    expect(await memorySyncCommand({ dir: REPO_DIR }, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "Error: memory is disabled (memory.enabled is false)",
      "Error: memory is disabled (memory.enabled is false)",
    ]);
  });
});

// ─── the mirror it rebuilds ─────────────────────────────────────────────────

describe("nax memory reset — the mirror it rebuilds", () => {
  test("AC-4: every entry of the project mirror is removed except the approvals", async () => {
    const h = makeResetHarness();

    expect(await runReset(h)).toBe(0);
    expect(h.removed).toEqual([join(PROJECT_DIR, "notes"), OUTBOX_PATH, CURSOR_PATH]);
    expect(h.removed.every((path) => path.startsWith(`${PROJECT_DIR}/`))).toBe(true);
    expect(namesUnder(h.files, PROJECT_DIR)).toEqual(["koda-approvals.json"]);
  });

  test("AC-5: the approvals file keeps its exact bytes", async () => {
    const h = makeResetHarness();

    expect(await runReset(h)).toBe(0);
    expect(h.files.get(APPROVALS_PATH)).toBe(APPROVALS_BYTES);
    expect(h.removed).not.toContain(APPROVALS_PATH);
  });

  test("AC-5: the approvals file survives on disk byte for byte", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "memory");
      const projectDir = join(root, "projects", "repo-abc12345");
      const userDir = join(root, "user");
      await realAdminDeps.writeText(join(projectDir, "koda-approvals.json"), APPROVALS_BYTES);
      await realAdminDeps.writeText(join(projectDir, "notes", "staging-db.md"), "the body of staging-db\n");
      await realAdminDeps.writeText(join(projectDir, "sync.json"), '{"lastPullAt":null}\n');
      await realAdminDeps.writeText(join(userDir, "pref.md"), USER_NOTE_BODY);
      const h = makeResetHarness({ fs: realAdminDeps, dirs: { root, projectDir, userDir } });

      expect(await runReset(h)).toBe(0);
      expect(await realAdminDeps.readText(join(projectDir, "koda-approvals.json"))).toBe(APPROVALS_BYTES);
      expect(await realAdminDeps.readText(join(projectDir, "notes", "staging-db.md"))).toBeNull();
      expect(await realAdminDeps.readText(join(projectDir, "sync.json"))).toBeNull();
      expect(await realAdminDeps.readText(join(userDir, "pref.md"))).toBe(USER_NOTE_BODY);
    });
  });

  test("AC-6: the user mirror is never read, removed or rewritten", async () => {
    const h = makeResetHarness();

    expect(await runReset(h)).toBe(0);
    expect(h.files.get(USER_NOTE_PATH)).toBe(USER_NOTE_BODY);
    expect(h.listed).toEqual([PROJECT_DIR]);
    expect(h.removed.some((path) => path === USER_DIR || path.startsWith(`${USER_DIR}/`))).toBe(false);
  });

  test("AC-7: the sync runs once, after the last removal", async () => {
    const h = makeResetHarness();

    expect(await runReset(h)).toBe(0);
    expect(h.events).toEqual([
      `list ${PROJECT_DIR}`,
      `remove ${join(PROJECT_DIR, "notes")}`,
      `remove ${OUTBOX_PATH}`,
      `remove ${CURSOR_PATH}`,
      "sync",
    ]);
  });
});

// ─── the result it prints ───────────────────────────────────────────────────

describe("nax memory reset — the result it prints", () => {
  test("AC-8: the sync result is printed as formatMemorySyncResult renders it", async () => {
    const h = makeResetHarness();

    expect(await runReset(h)).toBe(0);
    expect(h.out).toEqual([SYNCED_LINE]);
    expect(h.err).toEqual([]);
  });

  test("AC-9: --json prints the sync result as one document", async () => {
    const h = makeResetHarness();

    expect(await runReset(h, { json: true })).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] ?? "")).toEqual(SYNCED);
  });

  test("AC-10: a synced outcome returns 0", async () => {
    const h = makeResetHarness({ result: SYNCED });

    expect(await runReset(h)).toBe(0);
    expect(h.codes).toEqual([]);
  });

  test("AC-11: an unreachable outcome returns 1, because the mirror is now empty", async () => {
    const h = makeResetHarness({ result: UNREACHABLE });

    expect(await runReset(h)).toBe(1);
    expect(h.out).toEqual(["memory sync: unreachable"]);
    expect(h.files.has(CURSOR_PATH)).toBe(false);
  });

  test.each([
    { result: LOCKED, line: "memory sync: locked" },
    { result: FAILED, line: "memory sync: failed: lock busy" },
  ])("AC-13: a %p outcome returns 1 and still prints the result", async ({ result, line }) => {
    const h = makeResetHarness({ result });

    expect(await runReset(h)).toBe(1);
    expect(h.out).toEqual([line]);
    expect(h.err).toEqual([]);
  });
});

// ─── registration ───────────────────────────────────────────────────────────

describe("registerMemoryCommand — reset", () => {
  test("AC-12: nax memory reset reaches the command and rebuilds the mirror", async () => {
    const h = makeResetHarness();
    const program = new Command();
    registerMemoryCommand(program, h.deps);

    await program.parseAsync(["node", "nax", "memory", "reset", "--dir", REPO_DIR]);

    expect(h.hostCalls.map((call) => call.repoRoot)).toEqual([REPO_DIR]);
    expect(h.events).toContain("sync");
    expect(h.files.has(CURSOR_PATH)).toBe(false);
    expect(h.files.get(APPROVALS_PATH)).toBe(APPROVALS_BYTES);
    expect(h.out).toEqual([SYNCED_LINE]);
    expect(h.codes).toEqual([0]);
  });

  test("AC-12: reset is registered after link", () => {
    const program = new Command();
    registerMemoryCommand(program, makeResetHarness().deps);
    const memory = program.commands.find((command) => command.name() === "memory");
    assertDefined(memory, "the memory command");

    expect(memory.commands.map((command) => command.name())).toEqual([
      "status",
      "list",
      "show",
      "sync",
      "save",
      "forget",
      "approve",
      "link",
      "reset",
    ]);
  });
});
