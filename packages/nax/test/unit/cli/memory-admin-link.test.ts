/**
 * US-010 — `nax memory link`: point a repository at the koda project that holds its memories.
 *
 * Every case drives `memoryLinkCommand` (or the program `registerMemoryCommand` builds) with the
 * three seams a link acts through stubbed: `_memoryAdminDeps` (the project config and its
 * temporary file, plus the project mirror a relink discards), `_kodaClientDeps.fetch` (the
 * write-mode probe) and `deps.createMemoryHost` (the host a forced relink opens). What is pinned
 * is the file that lands on disk, the line that reaches each output channel, the exit code, and
 * — for every refusal — that nothing was written.
 *
 * The stub for the filesystem records the writes, renames and removals in order, so a case can
 * assert that the write precedes the removal rather than only that both happened. Two cases
 * read a real directory instead: the config a link creates where there is none (whose parent
 * directory must be created for it), and the seam's own members, which US-011's `reset` builds
 * on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, makeNaxConfig, withTempDir } from "@test/helpers";
import { Command } from "commander";
import { _memoryAdminDeps, type MemoryCliDeps, memoryLinkCommand, registerMemoryCommand } from "@/cli";
import { restoreProjectConfig } from "@/cli/memory-admin-config";
import type { NaxConfig } from "@/config";
import type { CreateMemoryHostInput, MemoryHost } from "@/memory";
import { _kodaClientDeps } from "@/memory/koda-http";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The repository every stubbed-filesystem case links; `--dir` names it. */
const REPO = "/repo";
/** The project config a link rewrites, and the temporary file it is staged in. */
const CONFIG_PATH = join(REPO, ".nax", "config.json");
const TMP_PATH = `${CONFIG_PATH}.tmp`;
/** The global half of the config: the API root and the bearer key, both global-only. */
const KODA_URL = "https://koda.example/api";
const KODA_HEADERS = { Authorization: "Bearer k3y" };
/** The project mirror a forced relink discards. */
const PROJECT_DIR = "/mirror/projects/rs-abc12345";
/** The slug under test, and the one a project config already names. */
const SLUG = "rs-stock";
const OTHER = "other";

/** A project config that is already linked to a different koda project. */
const OTHER_LINKED = '{\n  "memory": {\n    "koda": {\n      "project": "other"\n    }\n  }\n}\n';

/** A project config with keys a link must carry over untouched, other memory keys included. */
const RAW_PROJECT = `${[
  "{",
  '  "name": "rs-app",',
  '  "memory": {',
  '    "enabled": false,',
  '    "indexBytes": 4096,',
  '    "provider": "local"',
  "  },",
  '  "quality": {',
  '    "commands": {',
  '      "test": "bun test"',
  "    }",
  "  }",
  "}",
].join("\n")}\n`;

/** An untouched project config becomes exactly this text: two-space JSON plus one newline. */
const EXPECTED_NEW_CONFIG = `${[
  "{",
  '  "memory": {',
  '    "provider": "koda",',
  '    "koda": {',
  '      "project": "rs-stock"',
  "    }",
  "  }",
  "}",
].join("\n")}\n`;

// ─── stubs ───────────────────────────────────────────────────────────────────

/** One request the koda client issued, recorded so a case can assert the probe. */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** One config write, and one rename or removal, in the order they happened. */
interface TextWrite {
  readonly path: string;
  readonly text: string;
}

interface Rename {
  readonly from: string;
  readonly to: string;
}

interface FsCalls {
  readonly reads: string[];
  readonly writes: TextWrite[];
  readonly renames: Rename[];
  readonly removed: string[];
  /** `write`, `rename` and `remove` in the order they were called. */
  readonly events: string[];
}

/** The two counts a link reads from the host, and nothing else. */
interface HostCounts {
  readonly queued: number;
  readonly rejected: number;
}

/** The two things a relink touches — the project config and the mirror — held in memory. */
interface StatefulFs {
  /** The files the seam holds, keyed by path: the config, and the temp file while it exists. */
  readonly files: Map<string, string>;
  /** Every path `removePath` was asked for, in order. */
  readonly removed: string[];
  /** The members to install over the recorders. */
  readonly deps: Partial<typeof _memoryAdminDeps>;
}

/**
 * A stateful stand-in for what a relink touches, so a retried link reads what the run before it
 * left behind — which is the fact a rollback exists to establish.
 *
 * `failRemovals` makes the first N discards of the project mirror throw, and `failWritesFrom`
 * makes the write with that 1-based number — and every write after it — throw, so a case can
 * fail the rollback as well as the discard.
 */
function statefulFs(
  initial: string | null,
  failures: { readonly failRemovals?: number; readonly failWritesFrom?: number } = {},
): StatefulFs {
  const files = new Map<string, string>();
  if (initial !== null) files.set(CONFIG_PATH, initial);
  const removed: string[] = [];
  let removalsLeft = failures.failRemovals ?? 0;
  let writesSeen = 0;
  const deps: Partial<typeof _memoryAdminDeps> = {
    readText: async (path) => files.get(path) ?? null,
    writeText: async (path, text) => {
      writesSeen += 1;
      if (failures.failWritesFrom !== undefined && writesSeen >= failures.failWritesFrom) {
        throw new Error("ENOSPC: no space left on device");
      }
      files.set(path, text);
    },
    rename: async (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw new Error(`ENOENT: ${from}`);
      files.delete(from);
      files.set(to, text);
    },
    listDir: async () => [],
    removePath: async (path) => {
      removed.push(path);
      if (path === PROJECT_DIR && removalsLeft > 0) {
        removalsLeft -= 1;
        throw new Error("EBUSY: mirror busy");
      }
      files.delete(path);
    },
  };
  return { files, removed, deps };
}

/** The koda project the config in `store` names, or `undefined` when it names none. */
function projectIn(store: StatefulFs): unknown {
  const text = store.files.get(CONFIG_PATH);
  return text === undefined ? undefined : at(JSON.parse(text), "memory", "koda", "project");
}

/** What one case varies: the filesystem's answers, the host, the config and the repository. */
interface Fixture {
  /** What `readText` answers for the project config; `null` (the default) is "no file". */
  readonly projectConfig?: string | null;
  /** The two counts `host.status()` reports. */
  readonly counts?: HostCounts;
  /** The host `createMemoryHost` answers with; `null` is a mirror that is switched off. */
  readonly host?: MemoryHost | null;
  /** The merged config `loadConfig` answers with; the default is a global koda url and headers. */
  readonly loadConfig?: () => Promise<NaxConfig>;
  /** Filesystem members to put back after the recorders, for a case that wants the real ones. */
  readonly fs?: Partial<typeof _memoryAdminDeps>;
  /** The directory `--dir` names. */
  readonly repo?: string;
}

interface Harness {
  readonly deps: MemoryCliDeps;
  /** stdout lines. */
  readonly out: string[];
  /** stderr lines. */
  readonly err: string[];
  /** Every code handed to `exit`, in order. */
  readonly codes: number[];
  /** What the config seam was asked to do. */
  readonly fs: FsCalls;
  /** What each `createMemoryHost` call was given. */
  readonly hostCalls: CreateMemoryHostInput[];
  /** The directory `--dir` names. */
  readonly repo: string;
}

let probes: FetchCall[] = [];
let originalFetch: typeof _kodaClientDeps.fetch;
let originalFs: typeof _memoryAdminDeps = { ..._memoryAdminDeps };

/** A koda envelope answer carrying `body` at `status`. */
function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Answer every probe with `answer`, recording each request the client issues. */
function answerProbe(answer: () => Response | Promise<Response>): void {
  _kodaClientDeps.fetch = async (input, init) => {
    probes.push({ url: input, init });
    return await answer();
  };
}

/** A fresh global config: the koda API root and key, and no project linked yet. */
function globalConfig(): NaxConfig {
  return makeNaxConfig({ memory: { koda: { url: KODA_URL, headers: KODA_HEADERS } } });
}

/**
 * The host a forced relink opens: `status()` answers the two counts, and every other member
 * throws, so a case that reads one is told which member it reached.
 */
function linkedHost(counts: HostCounts): MemoryHost {
  const unread = async (): Promise<never> => {
    throw new Error("a link reads only the host's status");
  };
  return {
    dirs: { root: "/mirror", projectDir: PROJECT_DIR, userDir: "/mirror/user" },
    providerId: "koda:other",
    writeMode: "direct",
    notes: unread,
    getNote: unread,
    search: unread,
    renderIndex: unread,
    sync: unread,
    status: async () => ({
      enabled: true,
      provider: "koda:other",
      writeMode: "direct",
      projectDir: PROJECT_DIR,
      userDir: "/mirror/user",
      lastPullAt: null,
      lastError: null,
      queued: counts.queued,
      rejected: counts.rejected,
      notes: { project: 0, user: 0, repo: 0 },
      repoSkipped: 0,
    }),
    save: unread,
    forget: unread,
    approve: unread,
  };
}

/** The CLI with every seam a link acts through stubbed. */
function harness(fix: Fixture = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const hostCalls: CreateMemoryHostInput[] = [];
  const fs: FsCalls = { reads: [], writes: [], renames: [], removed: [], events: [] };
  const repo = fix.repo ?? REPO;
  const counts = fix.counts ?? { queued: 0, rejected: 0 };
  _memoryAdminDeps.readText = async (path) => {
    fs.reads.push(path);
    return fix.projectConfig ?? null;
  };
  _memoryAdminDeps.writeText = async (path, text) => {
    fs.writes.push({ path, text });
    fs.events.push("write");
  };
  _memoryAdminDeps.rename = async (from, to) => {
    fs.renames.push({ from, to });
    fs.events.push("rename");
  };
  _memoryAdminDeps.removePath = async (path) => {
    fs.removed.push(path);
    fs.events.push("remove");
  };
  _memoryAdminDeps.listDir = async () => [];
  Object.assign(_memoryAdminDeps, fix.fs ?? {});
  const deps: MemoryCliDeps = {
    log: (msg) => out.push(msg),
    logErr: (msg) => err.push(msg),
    exit: (code) => codes.push(code),
    findProjectDir: (dir) => join(dir, ".nax"),
    loadConfig: fix.loadConfig ?? (async () => globalConfig()),
    createMemoryHost: async (input) => {
      hostCalls.push(input);
      return fix.host === undefined ? linkedHost(counts) : fix.host;
    },
    readFile: async () => "",
  };
  return { deps, out, err, codes, fs, hostCalls, repo };
}

/** One link through the command function, as the operator's flags reach it. */
async function runLink(
  h: Harness,
  slug: string,
  extra: { readonly json?: boolean; readonly force?: boolean } = {},
): Promise<number> {
  return await memoryLinkCommand(slug, { dir: h.repo, ...extra }, h.deps);
}

/** The value at a dotted path inside a parsed document, or `undefined` when the path is absent. */
function at(document: unknown, ...keys: readonly string[]): unknown {
  let current = document;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/** The document the link wrote, parsed; it fails the case when nothing was written. */
function writtenConfig(h: Harness): unknown {
  const write = h.fs.writes[0];
  assertDefined(write, "a config write");
  return JSON.parse(write.text);
}

/** The line a probe answered with `mode`, over the global config's url and headers. */
function probePath(slug = SLUG): string {
  return `${KODA_URL}/projects/${slug}/memory/write-mode`;
}

beforeEach(() => {
  probes = [];
  originalFetch = _kodaClientDeps.fetch;
  originalFs = { ..._memoryAdminDeps };
});

afterEach(() => {
  _kodaClientDeps.fetch = originalFetch;
  Object.assign(_memoryAdminDeps, originalFs);
});

// ─── the write ───────────────────────────────────────────────────────────────

describe("nax memory link — the config it writes", () => {
  test("AC-1: links the repo to the project and returns 0", async () => {
    const h = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG)).toBe(0);
    const written = writtenConfig(h);
    expect(at(written, "memory", "provider")).toBe("koda");
    expect(at(written, "memory", "koda", "project")).toBe(SLUG);
    expect(h.err).toEqual([]);
  });

  test("AC-2: keeps every other key of the raw project config, other memory keys included", async () => {
    const h = harness({ projectConfig: RAW_PROJECT });
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG)).toBe(0);
    const written = writtenConfig(h);
    expect(at(written, "name")).toBe("rs-app");
    expect(at(written, "quality", "commands", "test")).toBe("bun test");
    expect(at(written, "memory", "enabled")).toBe(false);
    expect(at(written, "memory", "indexBytes")).toBe(4096);
    expect(at(written, "memory", "provider")).toBe("koda");
    expect(at(written, "memory", "koda", "project")).toBe(SLUG);
  });

  test("AC-3: the global url and headers do not reach the project config", async () => {
    const h = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG)).toBe(0);
    const written = writtenConfig(h);
    expect(at(written, "memory", "koda", "url")).toBeUndefined();
    expect(at(written, "memory", "koda", "headers")).toBeUndefined();
  });

  test("AC-4: writes the config, and its directory, when the file does not exist", async () => {
    await withTempDir(async (dir) => {
      const h = harness({ repo: dir, fs: { writeText: originalFs.writeText, rename: originalFs.rename } });
      answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

      expect(await runLink(h, SLUG)).toBe(0);
      const text = await Bun.file(join(dir, ".nax", "config.json")).text();
      expect(at(JSON.parse(text), "memory", "koda", "project")).toBe(SLUG);
    });
  });

  test("AC-5: the written text is two-space JSON followed by one newline", async () => {
    const h = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG)).toBe(0);
    expect(h.fs.writes).toHaveLength(1);
    expect(h.fs.writes[0]?.text).toBe(EXPECTED_NEW_CONFIG);
  });

  test("AC-6: it writes config.json.tmp and renames it onto config.json", async () => {
    const h = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG)).toBe(0);
    expect(h.fs.writes.map((write) => write.path)).toEqual([TMP_PATH]);
    expect(h.fs.renames).toEqual([{ from: TMP_PATH, to: CONFIG_PATH }]);
    expect(h.fs.events).toEqual(["write", "rename"]);
  });
});

// ─── the probe and the output ────────────────────────────────────────────────

describe("nax memory link — the probe and the line", () => {
  test("AC-7: it probes the project's write mode with the global config's headers", async () => {
    const h = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG)).toBe(0);
    expect(probes).toHaveLength(1);
    expect(probes[0]?.url).toBe(probePath());
    expect(probes[0]?.init.method).toBe("GET");
    expect(probes[0]?.init.headers).toMatchObject({ authorization: KODA_HEADERS.Authorization });
  });

  test("AC-8: it prints the link line", async () => {
    const h = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG)).toBe(0);
    expect(h.out).toEqual([`linked ${REPO} to koda project ${SLUG} (write mode: direct)`]);
  });

  test("AC-9: --json prints one document naming the project, the mode and the path", async () => {
    const h = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG, { json: true })).toBe(0);
    expect(h.out).toEqual([JSON.stringify({ project: SLUG, writeMode: "direct", configPath: CONFIG_PATH })]);
  });

  test("both output forms report the mode the probe answered, not a fixed one", async () => {
    const human = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "proposal" } }));
    expect(await runLink(human, SLUG)).toBe(0);
    expect(human.out).toEqual([`linked ${REPO} to koda project ${SLUG} (write mode: proposal)`]);

    const machine = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "proposal" } }));
    expect(await runLink(machine, SLUG, { json: true })).toBe(0);
    expect(machine.out).toEqual([JSON.stringify({ project: SLUG, writeMode: "proposal", configPath: CONFIG_PATH })]);
  });
});

// ─── the refusals ────────────────────────────────────────────────────────────

describe("nax memory link — what it refuses", () => {
  test("AC-10: a slug that is not a koda project slug", async () => {
    const h = harness();

    expect(await runLink(h, "RS stock")).toBe(1);
    expect(h.err).toEqual(['[memory] "RS stock" is not a koda project slug']);
    expect(h.fs.writes).toEqual([]);
    expect(h.fs.reads).toEqual([]);
    expect(probes).toEqual([]);
  });

  test("AC-11: a loaded config without memory.koda.url", async () => {
    const h = harness({ loadConfig: async () => makeNaxConfig({ memory: { enabled: true } }) });

    expect(await runLink(h, SLUG)).toBe(1);
    expect(h.err).toEqual(["[memory] memory.koda.url is not set in ~/.nax/config.json"]);
    expect(h.fs.writes).toEqual([]);
    expect(probes).toEqual([]);
  });

  test("AC-12: a probe answered 403", async () => {
    const h = harness();
    answerProbe(() => jsonAnswer({ ret: 403, message: "forbidden" }, 403));

    expect(await runLink(h, SLUG)).toBe(1);
    expect(h.err[0]?.startsWith(`[memory] koda project "${SLUG}" is not reachable:`)).toBe(true);
    expect(h.err[0]).toContain("403");
    expect(h.fs.writes).toEqual([]);
  });

  test("AC-13: a probe answered with a write mode koda does not write with", async () => {
    const h = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "other" } }));

    expect(await runLink(h, SLUG)).toBe(1);
    expect(h.err[0]?.startsWith(`[memory] koda project "${SLUG}" is not reachable:`)).toBe(true);
    expect(h.fs.writes).toEqual([]);
  });

  test("AC-14: a project config that is not JSON, read before the config is loaded", async () => {
    const h = harness({
      projectConfig: "{ broken",
      loadConfig: async () => {
        throw new Error("the loader must not be reached");
      },
    });

    expect(await runLink(h, SLUG)).toBe(1);
    expect(h.err).toEqual([`[memory] cannot link: ${CONFIG_PATH} is not valid JSON`]);
    expect(h.fs.writes).toEqual([]);
    expect(probes).toEqual([]);
  });

  test("AC-15: a project config that is JSON but not an object", async () => {
    const h = harness({ projectConfig: "[1]" });

    expect(await runLink(h, SLUG)).toBe(1);
    expect(h.err).toEqual([`[memory] cannot link: ${CONFIG_PATH} is not a JSON object`]);
    expect(h.fs.writes).toEqual([]);
  });

  test("AC-16: another koda project already linked, without --force", async () => {
    const h = harness({ projectConfig: OTHER_LINKED });

    expect(await runLink(h, SLUG)).toBe(1);
    expect(h.err).toEqual([
      `[memory] already linked to koda project "${OTHER}"; pass --force to relink (the project mirror is rebuilt)`,
    ]);
    expect(h.fs.writes).toEqual([]);
    expect(h.hostCalls).toEqual([]);
    expect(probes).toEqual([]);
  });

  test("AC-17: a forced relink while writes are still undelivered", async () => {
    const h = harness({ projectConfig: OTHER_LINKED, counts: { queued: 1, rejected: 0 } });

    expect(await runLink(h, SLUG, { force: true })).toBe(1);
    expect(h.err).toEqual([
      "[memory] 1 writes are not delivered; run nax memory sync (or nax memory forget) before relinking",
    ]);
    expect(h.fs.writes).toEqual([]);
    expect(h.fs.removed).toEqual([]);
    expect(probes).toEqual([]);
  });

  test("AC-21: a probe that throws", async () => {
    const h = harness();
    _kodaClientDeps.fetch = async () => {
      throw new Error("socket closed");
    };

    expect(await runLink(h, SLUG)).toBe(1);
    const line = h.err[0] ?? "";
    expect(line.startsWith(`[memory] koda project "${SLUG}" is not reachable:`)).toBe(true);
    expect(line).toContain("socket closed");
    expect(h.fs.writes).toEqual([]);
  });

  test("AC-22: a merged config that does not load", async () => {
    const h = harness({
      loadConfig: async () => {
        throw new Error("Invalid configuration:\nmemory.koda.url: needed");
      },
    });

    expect(await runLink(h, SLUG)).toBe(1);
    expect(h.err).toEqual(["Error: Invalid configuration:\nmemory.koda.url: needed"]);
    expect(h.fs.writes).toEqual([]);
  });
});

// ─── the forced relink ──────────────────────────────────────────────────────

describe("nax memory link — the project mirror a forced relink discards", () => {
  test("AC-18: a forced relink writes the config and then removes the project mirror", async () => {
    const h = harness({ projectConfig: OTHER_LINKED });
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG, { force: true })).toBe(0);
    expect(h.fs.writes).toHaveLength(1);
    expect(h.fs.removed).toEqual([PROJECT_DIR]);
    expect(h.fs.events).toEqual(["write", "rename", "remove"]);
    expect(h.hostCalls).toHaveLength(1);
  });

  test("AC-19: --force on the project already linked succeeds and removes nothing", async () => {
    const h = harness({ projectConfig: `{ "memory": { "koda": { "project": "${SLUG}" } } }` });
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG, { force: true })).toBe(0);
    expect(h.fs.writes).toHaveLength(1);
    expect(h.fs.removed).toEqual([]);
    // — not a forced relink, so no host is opened and the mirror is not in play at all.
    expect(h.hostCalls).toEqual([]);
  });

  test("linking the same project again needs no --force and removes nothing", async () => {
    const h = harness({ projectConfig: `{ "memory": { "koda": { "project": "${SLUG}" } } }` });
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG)).toBe(0);
    expect(h.fs.writes).toHaveLength(1);
    expect(h.fs.removed).toEqual([]);
  });

  test("--force on a project that names none is not a relink: no host, no removal", async () => {
    const h = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG, { force: true })).toBe(0);
    expect(h.hostCalls).toEqual([]);
    expect(h.fs.removed).toEqual([]);
  });

  test("a forced relink with memory disabled skips the undelivered check and the removal", async () => {
    const h = harness({ projectConfig: OTHER_LINKED, counts: { queued: 5, rejected: 0 }, host: null });
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG, { force: true })).toBe(0);
    expect(h.fs.writes).toHaveLength(1);
    expect(h.fs.removed).toEqual([]);
  });

  test("F1: a discard that fails rolls the config back, so --force discards the old mirror", async () => {
    const store = statefulFs(OTHER_LINKED, { failRemovals: 1 });
    const h = harness({ fs: store.deps });
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    // The discard fails after the config was written: the write is undone, so the repository is
    // left linking what it linked before rather than the new project on the old mirror.
    expect(await runLink(h, SLUG, { force: true })).toBe(1);
    expect(store.files.get(CONFIG_PATH)).toBe(OTHER_LINKED);
    expect(projectIn(store)).toBe(OTHER);
    expect(store.removed).toEqual([PROJECT_DIR]);

    // The retry therefore reads the old slug as the project being replaced, and discards again.
    expect(await runLink(h, SLUG, { force: true })).toBe(0);
    expect(store.removed).toEqual([PROJECT_DIR, PROJECT_DIR]);
    expect(projectIn(store)).toBe(SLUG);
  });

  test("F1: a rollback that fails too says the old mirror is still attached", async () => {
    const store = statefulFs(OTHER_LINKED, { failRemovals: 1, failWritesFrom: 2 });
    const h = harness({ fs: store.deps });
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG, { force: true })).toBe(1);
    const line = h.err[0] ?? "";
    expect(line).toContain(PROJECT_DIR);
    expect(line).toContain(CONFIG_PATH);
    expect(line).toContain("still attached");
    // Nothing could be undone: the file names the new project, so the message must say so.
    expect(projectIn(store)).toBe(SLUG);
  });

  test("a config write that fails reports it, and discards no mirror", async () => {
    const store = statefulFs(OTHER_LINKED, { failWritesFrom: 1 });
    const h = harness({ fs: store.deps });
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await runLink(h, SLUG, { force: true })).toBe(1);
    expect(h.err).toEqual([`Error: [memory] cannot write ${CONFIG_PATH}: ENOSPC: no space left on device`]);
    // The config still names the project the mirror belongs to, so the mirror must survive.
    expect(store.files.get(CONFIG_PATH)).toBe(OTHER_LINKED);
    expect(store.removed).toEqual([]);
  });
});

// ─── the project config document ────────────────────────────────────────────

describe("restoreProjectConfig", () => {
  test("a config the link created is removed, not emptied", async () => {
    const store = statefulFs(null);
    Object.assign(_memoryAdminDeps, store.deps);
    store.files.set(CONFIG_PATH, '{ "memory": { "provider": "koda" } }\n');

    await restoreProjectConfig(CONFIG_PATH, null);

    expect(store.files.has(CONFIG_PATH)).toBe(false);
    expect(store.removed).toEqual([CONFIG_PATH]);
  });

  test("a config that existed is put back byte for byte", async () => {
    const store = statefulFs(null);
    Object.assign(_memoryAdminDeps, store.deps);
    store.files.set(CONFIG_PATH, '{"memory":{"koda":{"project":"other"}}}');

    await restoreProjectConfig(CONFIG_PATH, OTHER_LINKED);

    expect(store.files.get(CONFIG_PATH)).toBe(OTHER_LINKED);
    expect(store.removed).toEqual([]);
  });
});

// ─── registration ────────────────────────────────────────────────────────────

describe("registerMemoryCommand — link", () => {
  test("AC-20: nax memory link rs-stock reaches the command through the program", async () => {
    const h = harness();
    answerProbe(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));
    const program = new Command();
    registerMemoryCommand(program, h.deps);

    await program.parseAsync(["node", "nax", "memory", "link", SLUG, "--dir", REPO]);

    expect(probes.map((call) => call.url)).toEqual([probePath()]);
    expect(at(writtenConfig(h), "memory", "koda", "project")).toBe(SLUG);
    expect(h.codes).toEqual([0]);
  });

  test("AC-23: link is registered after approve", () => {
    const program = new Command();
    registerMemoryCommand(program, harness().deps);
    const memory = program.commands.find((command) => command.name() === "memory");
    assertDefined(memory, "the memory command");

    expect(memory.commands.map((command) => command.name()).slice(0, 8)).toEqual([
      "status",
      "list",
      "show",
      "sync",
      "save",
      "forget",
      "approve",
      "link",
    ]);
  });
});

// ─── the filesystem seam ─────────────────────────────────────────────────────

describe("_memoryAdminDeps", () => {
  test("readText answers null for a file that does not exist", async () => {
    await withTempDir(async (dir) => {
      expect(await originalFs.readText(join(dir, "absent.json"))).toBeNull();
    });
  });

  test("writeText creates the parent directories, and rename puts the text in place", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, ".nax", "config.json");
      await originalFs.writeText(`${target}.tmp`, "{}\n");
      await originalFs.rename(`${target}.tmp`, target);

      expect(await Bun.file(target).text()).toBe("{}\n");
      expect(await Bun.file(`${target}.tmp`).exists()).toBe(false);
    });
  });

  test("listDir answers [] for an absent directory and its entry names otherwise", async () => {
    await withTempDir(async (dir) => {
      expect(await originalFs.listDir(join(dir, "absent"))).toEqual([]);
      await originalFs.writeText(join(dir, "mirror", "notes.json"), "[]");
      expect(await originalFs.listDir(join(dir, "mirror"))).toEqual(["notes.json"]);
    });
  });

  test("removePath removes a tree, and a missing path is not an error", async () => {
    await withTempDir(async (dir) => {
      await originalFs.writeText(join(dir, "mirror", "notes.json"), "[]");
      await originalFs.removePath(join(dir, "mirror"));
      expect(await Bun.file(join(dir, "mirror", "notes.json")).exists()).toBe(false);
      await originalFs.removePath(join(dir, "mirror"));
    });
  });
});
