/**
 * The stubs `nax memory link` is driven through, shared by the two test files that cover it.
 *
 * A link acts through three seams — `_memoryAdminDeps` (the project config and its temporary
 * file, the mirror's relink record, and the mirror a relink discards), `_kodaClientDeps.fetch`
 * (the write-mode probe) and `deps.createMemoryHost` (the host it opens) — and every case needs
 * the same harness around them. Two files use it: `cli/memory-admin-link.test.ts` (the checks,
 * the config it writes, the probe, the output and the registration) and
 * `cli/memory-admin-link-relink.test.ts` (the mirror transition a forced relink makes).
 *
 * Two stand-ins are here because a case needs both kinds of answer:
 *
 *   - `makeLinkHarness` records what the config seam was asked to do and answers from a fixture
 *     that is fixed for the case, which is what the refusal cases need.
 *   - `statefulFs` keeps the project config and the mirror's record in memory across runs, so a
 *     retried link reads what the run before it left — the fact a rollback and a relink record
 *     exist to establish. It can also fail the Nth write to one path, or the first N discards.
 */
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import { _memoryAdminDeps, type MemoryCliDeps, memoryLinkCommand } from "@/cli";
import type { NaxConfig } from "@/config";
import type { CreateMemoryHostInput, MemoryHost } from "@/memory";
import { _kodaClientDeps } from "@/memory/koda-http";
import { assertDefined } from "./assert-defined";

// ─── the repository under test ───────────────────────────────────────────────

/** The directory `--dir` names in every stubbed case; the repo root is this directory. */
export const LINK_REPO = "/repo";
/** The project config a link rewrites. */
export const LINK_CONFIG_PATH = join(LINK_REPO, ".nax", "config.json");
/** The file the config is staged in before the rename puts it in place. */
export const LINK_TMP_PATH = `${LINK_CONFIG_PATH}.tmp`;
/** The global half of the config: the API root and the bearer key, both global-only. */
export const KODA_URL = "https://koda.example/api";
export const KODA_HEADERS = { Authorization: "Bearer k3y" };
/** The project mirror a forced relink discards. */
export const MIRROR_DIR = "/mirror/projects/rs-abc12345";
/** The record a relink leaves inside the mirror before it changes the config (the on-disk name). */
export const RELINK_RECORD_PATH = join(MIRROR_DIR, "relink-pending.json");
/** The slug under test, and the project a config in these cases already names. */
export const LINK_SLUG = "rs-stock";
export const OTHER_PROJECT = "other";

/** A project config that is already linked to a different koda project. */
export const OTHER_LINKED = '{\n  "memory": {\n    "koda": {\n      "project": "other"\n    }\n  }\n}\n';

/** A project config already linked to `slug`, as a link leaves it. */
export const LINKED_TO_SLUG = `{ "memory": { "koda": { "project": "${LINK_SLUG}" } } }`;

/** A project config with keys a link must carry over untouched, other memory keys included. */
export const RAW_PROJECT = `${[
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
export const EXPECTED_NEW_CONFIG = `${[
  "{",
  '  "memory": {',
  '    "provider": "koda",',
  '    "koda": {',
  '      "project": "rs-stock"',
  "    }",
  "  }",
  "}",
].join("\n")}\n`;

/** The project config's path inside a repository directory. */
export function linkConfigPathIn(repo: string): string {
  return join(repo, ".nax", "config.json");
}

/** The URL the write-mode probe asks koda for. */
export function probeUrlFor(slug = LINK_SLUG): string {
  return `${KODA_URL}/projects/${slug}/memory/write-mode`;
}

// ─── recorded calls ─────────────────────────────────────────────────────────

/** One request the koda client issued, recorded so a case can assert the probe. */
export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** One write the config seam was asked for. */
export interface TextWrite {
  readonly path: string;
  readonly text: string;
}

export interface Rename {
  readonly from: string;
  readonly to: string;
}

/** What the config seam was asked to do, in the order it was asked. */
export interface FsCalls {
  readonly reads: string[];
  readonly writes: TextWrite[];
  readonly renames: Rename[];
  readonly removed: string[];
  /** `write`, `rename` and `remove` in the order they were called. */
  readonly events: string[];
}

/** The two counts a link reads from the host, and nothing else. */
export interface HostCounts {
  readonly queued: number;
  readonly rejected: number;
}

// ─── the harness ───────────────────────────────────────────────────────────

/** What one case varies: the filesystem's answers, the host, the config and the repository. */
export interface LinkFixture {
  /** What `readText` answers for the project config; `null` (the default) is "no file". */
  readonly projectConfig?: string | null;
  /** The two counts `host.status()` reports. */
  readonly counts?: HostCounts;
  /** The host `createMemoryHost` answers with; `null` is a mirror that is switched off. */
  readonly host?: MemoryHost | null;
  /** The merged config `loadConfig` answers with; the default is a global koda url and headers. */
  readonly loadConfig?: () => Promise<NaxConfig>;
  /** Filesystem members to install over the recorders, for a case that wants the real ones. */
  readonly fs?: Partial<typeof _memoryAdminDeps>;
  /** The directory `--dir` names. */
  readonly repo?: string;
}

/** The stubbed CLI one case drives, and what it recorded. */
export interface LinkHarness {
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

/** The real filesystem members, kept so a case can drive the seam against a temp directory. */
export const realAdminDeps: typeof _memoryAdminDeps = { ..._memoryAdminDeps };

let probes: FetchCall[] = [];
let savedFetch: typeof _kodaClientDeps.fetch;
let savedFs: typeof _memoryAdminDeps = { ..._memoryAdminDeps };

/** A koda envelope answer carrying `body` at `status`. */
export function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Answer every probe with `answer`, recording each request the client issues. */
export function answerProbe(answer: () => Response | Promise<Response>): void {
  _kodaClientDeps.fetch = async (input, init) => {
    probes.push({ url: input, init });
    return await answer();
  };
}

/** The probes the current case issued, in order. */
export function probeCalls(): readonly FetchCall[] {
  return probes;
}

/** Snapshot the seams a case overrides; pair with `restoreSeams` in `afterEach`. */
export function saveSeams(): void {
  probes = [];
  savedFetch = _kodaClientDeps.fetch;
  savedFs = { ..._memoryAdminDeps };
}

/** Put the seams back as `saveSeams` found them. */
export function restoreSeams(): void {
  _kodaClientDeps.fetch = savedFetch;
  Object.assign(_memoryAdminDeps, savedFs);
}

/** A fresh global config: the koda API root and key, and no project linked yet. */
export function globalConfig(): NaxConfig {
  return makeNaxConfig({ memory: { koda: { url: KODA_URL, headers: KODA_HEADERS } } });
}

/**
 * The host a link opens: `status()` answers the two counts, and every other member throws, so a
 * case that reads one is told which member it reached.
 */
export function linkedHost(counts: HostCounts): MemoryHost {
  const unread = async (): Promise<never> => {
    throw new Error("a link reads only the host's status");
  };
  return {
    dirs: { root: "/mirror", projectDir: MIRROR_DIR, userDir: "/mirror/user" },
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
      projectDir: MIRROR_DIR,
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
export function makeLinkHarness(fix: LinkFixture = {}): LinkHarness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const hostCalls: CreateMemoryHostInput[] = [];
  const fs: FsCalls = { reads: [], writes: [], renames: [], removed: [], events: [] };
  const repo = fix.repo ?? LINK_REPO;
  const counts = fix.counts ?? { queued: 0, rejected: 0 };
  const configPath = linkConfigPathIn(repo);
  _memoryAdminDeps.readText = async (path) => {
    fs.reads.push(path);
    // Only the project config has a fixture: any other path (the mirror's record) is absent.
    return path === configPath ? (fix.projectConfig ?? null) : null;
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
export async function runLink(
  h: LinkHarness,
  slug: string,
  extra: { readonly json?: boolean; readonly force?: boolean } = {},
): Promise<number> {
  return await memoryLinkCommand(slug, { dir: h.repo, ...extra }, h.deps);
}

/** The value at a dotted path inside a parsed document, or `undefined` when the path is absent. */
export function at(document: unknown, ...keys: readonly string[]): unknown {
  let current = document;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

/** The project config text this run staged, as the seam recorded it. */
export function writtenConfigText(h: LinkHarness): string {
  const tmpPath = `${linkConfigPathIn(h.repo)}.tmp`;
  const write = h.fs.writes.find((candidate) => candidate.path === tmpPath);
  assertDefined(write, "a config write");
  return write.text;
}

/** The document the link wrote, parsed; it fails the case when nothing was written. */
export function writtenConfig(h: LinkHarness): unknown {
  return JSON.parse(writtenConfigText(h));
}

// ─── a filesystem that remembers ───────────────────────────────────────────

/**
 * The project config and the mirror, held in memory across runs.
 *
 * `removed` and `events` record what happened; `deps` installs the members over the harness's
 * recorders.
 */
export interface StatefulFs {
  /** The files the seam holds, keyed by path: the config, the record, and the temp files. */
  readonly files: Map<string, string>;
  /** Every path `removePath` was asked for, in order. */
  readonly removed: string[];
  /** `write <path>`, `rename <from> -> <to>` and `remove <path>`, in the order they happened. */
  readonly events: string[];
  /** The members to install over the recorders. */
  readonly deps: Partial<typeof _memoryAdminDeps>;
}

/**
 * A stateful stand-in for what a relink touches, so a retried link reads what the run before it
 * left behind.
 *
 * `failRemovals` makes the first N discards of the project mirror throw; `failWritesTo` makes a
 * write to one path throw once that path has been written `after` times (for at most `times`
 * writes), so a case can fail the rollback of the config without failing the link's own write.
 */
export function statefulFs(
  initial: string | null,
  failures: {
    readonly failRemovals?: number;
    readonly failWritesTo?: { readonly path: string; readonly after: number; readonly times?: number };
  } = {},
): StatefulFs {
  const files = new Map<string, string>();
  if (initial !== null) files.set(LINK_CONFIG_PATH, initial);
  const removed: string[] = [];
  const events: string[] = [];
  const writeCounts = new Map<string, number>();
  let removalsLeft = failures.failRemovals ?? 0;
  let writeFailuresLeft = failures.failWritesTo?.times ?? Number.POSITIVE_INFINITY;
  const deps: Partial<typeof _memoryAdminDeps> = {
    readText: async (path) => files.get(path) ?? null,
    writeText: async (path, text) => {
      const target = failures.failWritesTo;
      const written = writeCounts.get(path) ?? 0;
      if (target !== undefined && target.path === path && written >= target.after && writeFailuresLeft > 0) {
        writeFailuresLeft -= 1;
        throw new Error("ENOSPC: no space left on device");
      }
      writeCounts.set(path, written + 1);
      events.push(`write ${path}`);
      files.set(path, text);
    },
    rename: async (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw new Error(`ENOENT: ${from}`);
      events.push(`rename ${from} -> ${to}`);
      files.delete(from);
      files.set(to, text);
    },
    listDir: async () => [],
    removePath: async (path) => {
      events.push(`remove ${path}`);
      removed.push(path);
      if (path === MIRROR_DIR && removalsLeft > 0) {
        removalsLeft -= 1;
        throw new Error("EBUSY: mirror busy");
      }
      // A removal takes the tree with it, the record inside the mirror included.
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      }
    },
  };
  return { files, removed, events, deps };
}

/** The koda project the config in `store` names, or `undefined` when it names none. */
export function projectIn(store: StatefulFs): unknown {
  const text = store.files.get(LINK_CONFIG_PATH);
  return text === undefined ? undefined : at(JSON.parse(text), "memory", "koda", "project");
}
