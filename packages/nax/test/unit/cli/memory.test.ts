/**
 * US-016 — the `nax memory` group's two read subcommands.
 *
 * Every case enters through `program.parseAsync(["node", "nax", "memory", …])` with the
 * `MemoryCliDeps` seam stubbed, so what is pinned is the CLI as an operator invokes it: the
 * flags each subcommand takes, the repo root and config it resolves for `--dir`, what it
 * hands `createMemoryHost` (source, logger), what reaches each output channel, and which
 * code the action hands to `deps.exit`.
 *
 * No mirror is read and no note is written: the host is stubbed at the dependency seam, and
 * the two cases that need a real `.nax` walk-up build one inside a temp directory.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryNote } from "@nathapp/nax-agent";
import { assertDefined, makeNaxConfig, withTempDir } from "@test/helpers";
import { Command } from "commander";
import { _memoryCliDeps, type MemoryCliDeps, registerMemoryCommand } from "@/cli";
import { findProjectDir } from "@/config";
import { NaxError } from "@/errors";
import type { CreateMemoryHostInput, MemoryHost, MemoryStatus } from "@/memory";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The status a live host reports; `formatMemoryStatus` is what `status` prints for it. */
const STATUS: MemoryStatus = {
  enabled: true,
  provider: "local",
  writeMode: "direct",
  projectDir: "/home/u/.nax/memory/projects/nax-monorepo-1a2b3c4d",
  userDir: "/home/u/.nax/memory/user",
  lastPullAt: "2026-11-02T08:11:00.000Z",
  lastError: null,
  queued: 0,
  rejected: 0,
  rejectedEntries: [],
  notes: { project: 2, user: 2, repo: 0 },
  repoSkipped: 0,
};

/** One note, filled in; each case varies the field it sorts or filters on. */
function note(over: Partial<MemoryNote> & Pick<MemoryNote, "slug">): MemoryNote {
  return {
    id: "nax-chat",
    type: "project",
    scope: "project",
    description: `${over.slug} description`,
    source: "nax-chat",
    updatedAt: "2026-11-02T08:11:00.000Z",
    status: "active",
    body: `the body of ${over.slug}`,
    ...over,
  };
}

/**
 * The mirror's notes, deliberately out of slug order and interleaved by type: a listing
 * that printed them as the host returned them could not be the ordering the CLI promises.
 */
const PROJECT_NOTES: readonly MemoryNote[] = [
  note({ slug: "staging-db", type: "project", description: "shared staging db" }),
  note({ slug: "always-commits", type: "feedback", description: "conventional commits" }),
];
const USER_NOTES: readonly MemoryNote[] = [
  note({ slug: "reply-style", type: "user", scope: "user", source: "human", description: "terse replies" }),
  note({ slug: "always-tests", type: "feedback", scope: "user", source: "human", description: "test first" }),
];

/** A `MemoryHost` whose two reads this file drives; every other member is unread. */
function fakeHost(over: Partial<MemoryHost> = {}): MemoryHost {
  const unread = async (): Promise<never> => {
    throw new Error("this test reads only status and notes");
  };
  return {
    dirs: { root: "/m", projectDir: "/m/projects/p", userDir: "/m/user" },
    providerId: "local",
    writeMode: "direct",
    notes: async (scope) => (scope === "project" ? PROJECT_NOTES : USER_NOTES),
    getNote: unread,
    search: unread,
    renderIndex: unread,
    sync: unread,
    status: async () => STATUS,
    save: unread,
    forget: unread,
    approve: unread,
    ...over,
  };
}

interface Harness {
  readonly deps: MemoryCliDeps;
  /** stdout lines. */
  readonly out: string[];
  /** stderr lines. */
  readonly err: string[];
  /** Every code handed to `exit`, in order. */
  readonly codes: number[];
  /** What each `createMemoryHost` call was given. */
  readonly hostCalls: CreateMemoryHostInput[];
  /** The `startDir` of each `loadConfig` call. */
  readonly configDirs: (string | undefined)[];
}

/**
 * The CLI with every external call stubbed. `findProjectDir` answers `null` by default —
 * a directory with no repository above it, which is what most cases want.
 */
function harness(over: Partial<MemoryCliDeps> = {}, hostOver: Partial<MemoryHost> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const hostCalls: CreateMemoryHostInput[] = [];
  const configDirs: (string | undefined)[] = [];
  const deps: MemoryCliDeps = {
    log: (msg) => out.push(msg),
    logErr: (msg) => err.push(msg),
    exit: (code) => codes.push(code),
    findProjectDir: () => null,
    loadConfig: async (startDir?: string) => {
      configDirs.push(startDir);
      return makeNaxConfig();
    },
    createMemoryHost: async (input) => {
      hostCalls.push(input);
      return fakeHost(hostOver);
    },
    readFile: async () => "",
    ...over,
  };
  return { deps, out, err, codes, hostCalls, configDirs };
}

/** `nax memory <args>` through a program the command registered itself on. */
async function runMemory(h: Harness, args: readonly string[]): Promise<void> {
  const program = new Command();
  registerMemoryCommand(program, h.deps);
  await program.parseAsync(["node", "nax", "memory", ...args]);
}

/** The single host the command created; fails loudly when it created none. */
function onlyHostCall(h: Harness): CreateMemoryHostInput {
  expect(h.hostCalls).toHaveLength(1);
  const call = h.hostCalls[0];
  assertDefined(call, "the createMemoryHost call");
  return call;
}

// ─── status ──────────────────────────────────────────────────────────────────

describe("nax memory status", () => {
  test("AC-1: composes one host, labelled human", async () => {
    const h = harness();
    await runMemory(h, ["status"]);
    expect(h.hostCalls).toHaveLength(1);
    expect(onlyHostCall(h).source).toBe("human");
  });

  test("AC-4: prints the status block and exits 0", async () => {
    const h = harness();
    await runMemory(h, ["status"]);
    expect(h.out).toEqual([formatStatusBlock()]);
    expect(h.codes).toEqual([0]);
    expect(h.err).toEqual([]);
  });

  test("AC-5: --json prints one document equal to the host's status", async () => {
    const h = harness();
    await runMemory(h, ["status", "--json"]);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] ?? "")).toEqual(STATUS);
    expect(h.codes).toEqual([0]);
  });

  test("AC-6: a disabled host prints enabled: false and exits 0", async () => {
    const h = harness({ createMemoryHost: async () => null });
    await runMemory(h, ["status"]);
    expect(h.out).toEqual(["enabled: false"]);
    expect(h.codes).toEqual([0]);
  });

  test('AC-7: a disabled host under --json prints {"enabled":false}', async () => {
    const h = harness({ createMemoryHost: async () => null });
    await runMemory(h, ["status", "--json"]);
    expect(h.out).toEqual(['{"enabled":false}']);
    expect(h.codes).toEqual([0]);
  });

  test("AC-8: the host's logger writes a warn to stderr as a [memory] line", async () => {
    const h = harness();
    await runMemory(h, ["status"]);
    const logger = onlyHostCall(h).logger;
    logger.info("memory", "sync started", {});
    logger.debug("memory", "store opened", {});
    expect(h.err).toEqual([]);
    logger.warn("memory", "repo note skipped", { path: "/r/.nax/memory/a.md", reason: "secret" });
    const line = h.err.at(-1) ?? "";
    expect(line.startsWith("[memory] repo note skipped")).toBe(true);
    expect(h.out).not.toContain(line);
  });

  test("AC-15: an unloadable config is Error: <message> on stderr and exit 1", async () => {
    const h = harness({
      loadConfig: async () => {
        throw new Error("bad json");
      },
    });
    await runMemory(h, ["status"]);
    expect(h.err).toEqual(["Error: bad json"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });
});

/** The block `formatMemoryStatus` prints for `STATUS` — the text a plain `status` prints. */
function formatStatusBlock(): string {
  return [
    "provider: local",
    "write mode: direct",
    "mirror: /home/u/.nax/memory/projects/nax-monorepo-1a2b3c4d",
    "user notes: /home/u/.nax/memory/user",
    "last sync: 2026-11-02T08:11:00.000Z",
    "outbox: 0 queued, 0 rejected",
    "notes: 2 project, 2 user, 0 repo",
  ].join("\n");
}

// ─── the repo root `--dir` resolves ─────────────────────────────────────────

describe("nax memory status --dir", () => {
  test("AC-2: a directory inside a repository resolves to the .nax parent", async () => {
    await withTempDir(async (tempDir) => {
      mkdirSync(join(tempDir, ".nax"), { recursive: true });
      writeFileSync(join(tempDir, ".nax", "config.json"), "{}\n");
      const appDir = join(tempDir, "packages", "app");
      mkdirSync(appDir, { recursive: true });
      const h = harness({ findProjectDir });
      await runMemory(h, ["status", "--dir", appDir]);
      expect(onlyHostCall(h).repoRoot).toBe(tempDir);
      expect(h.configDirs).toEqual([join(tempDir, ".nax")]);
    });
  });

  test("AC-3: a directory with no .nax above it resolves to --dir itself", async () => {
    await withTempDir(async (tempDir) => {
      const h = harness({ findProjectDir });
      await runMemory(h, ["status", "--dir", tempDir]);
      expect(onlyHostCall(h).repoRoot).toBe(tempDir);
      expect(h.configDirs).toEqual([undefined]);
    });
  });
});

// ─── list ────────────────────────────────────────────────────────────────────

/** The listing rows the CLI prints for `notes`, in the order it promises. */
function listingLines(notes: readonly MemoryNote[]): string[] {
  return notes.map(
    (entry) => `${entry.scope}/${entry.slug} [${entry.type}] ${entry.description} (${entry.status}; ${entry.source})`,
  );
}

describe("nax memory list", () => {
  test("AC-9: one line per note, project notes then user notes, each by slug", async () => {
    const h = harness();
    await runMemory(h, ["list"]);
    expect(h.out).toEqual(listingLines([PROJECT_NOTES[1], PROJECT_NOTES[0], USER_NOTES[1], USER_NOTES[0]]));
    expect(h.codes).toEqual([0]);
  });

  test("AC-10: --type feedback keeps only the feedback notes", async () => {
    const h = harness();
    await runMemory(h, ["list", "--type", "feedback"]);
    expect(h.out).toEqual(listingLines([PROJECT_NOTES[1], USER_NOTES[1]]));
    expect(h.codes).toEqual([0]);
  });

  test("AC-11: --scope user keeps only the user notes", async () => {
    const h = harness();
    await runMemory(h, ["list", "--scope", "user"]);
    expect(h.out).toEqual(listingLines([USER_NOTES[1], USER_NOTES[0]]));
    expect(h.codes).toEqual([0]);
  });

  test("AC-12: --json prints {notes:[…]} whose entries carry slug and source but no body", async () => {
    const h = harness();
    await runMemory(h, ["list", "--json"]);
    expect(h.out).toHaveLength(1);
    const parsed = JSON.parse(h.out[0] ?? "") as { notes: Record<string, unknown>[] };
    expect(parsed.notes.map((entry) => entry.slug)).toEqual([
      "always-commits",
      "staging-db",
      "always-tests",
      "reply-style",
    ]);
    for (const entry of parsed.notes) {
      expect(entry.source).toBeDefined();
      expect(Object.keys(entry)).not.toContain("body");
    }
    expect(h.codes).toEqual([0]);
  });

  test("AC-13: an unknown --type is an Error naming it, and exit 1", async () => {
    const h = harness();
    await runMemory(h, ["list", "--type", "nope"]);
    const line = h.err[0] ?? "";
    expect(line.startsWith("Error:")).toBe(true);
    expect(line).toContain("nope");
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("AC-14: a disabled host refuses the listing and exits 1", async () => {
    const h = harness({ createMemoryHost: async () => null });
    await runMemory(h, ["list"]);
    expect(h.err).toEqual(["Error: memory is disabled (memory.enabled is false)"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("AC-16: an unresolvable repo root exits 1", async () => {
    const h = harness({
      createMemoryHost: async () => {
        throw new NaxError("cannot resolve repository root /r", "MEMORY_REPO_ROOT_UNRESOLVED", { stage: "memory" });
      },
    });
    await runMemory(h, ["list"]);
    expect(h.codes).toEqual([1]);
    expect(h.err).toEqual(["Error: cannot resolve repository root /r"]);
  });

  test("US-006 AC-21: a row whose key the host reports as a pending forget ends with (forget pending)", async () => {
    const h = harness({}, { forgetPendingKeys: async () => new Set(["project/staging-db"]) });

    await runMemory(h, ["list"]);

    const line = h.out.find((row) => row.startsWith("project/staging-db "));
    assertDefined(line, "the staging-db row");
    expect(line.endsWith(" (forget pending)")).toBe(true);
    expect(h.out.filter((row) => row.endsWith(" (forget pending)"))).toHaveLength(1);
  });
});

// ─── registration ────────────────────────────────────────────────────────────

describe("registerMemoryCommand", () => {
  test("AC-17: adds a memory command with status and list", () => {
    const program = new Command();
    registerMemoryCommand(program, harness().deps);
    expect(program.commands.map((command) => command.name())).toContain("memory");
    const memory = program.commands.find((command) => command.name() === "memory");
    assertDefined(memory, "the memory command");
    // This file owns `status` and `list`; the whole group's order is pinned by
    // test/unit/cli/memory-read.test.ts, which registers the subcommands US-017 adds.
    expect(memory.commands.map((command) => command.name())).toEqual(expect.arrayContaining(["status", "list"]));
  });

  test("AC-18: the registration and its deps seam are importable from @/cli", () => {
    expect(typeof registerMemoryCommand).toBe("function");
    expect(typeof _memoryCliDeps.createMemoryHost).toBe("function");
    expect(typeof _memoryCliDeps.findProjectDir).toBe("function");
    expect(typeof _memoryCliDeps.readFile).toBe("function");
  });
});
