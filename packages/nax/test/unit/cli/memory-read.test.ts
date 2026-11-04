/**
 * US-017 — `nax memory show` and `nax memory sync`.
 *
 * Every case enters through `program.parseAsync(["node", "nax", "memory", …])` with the
 * `MemoryCliDeps` seam stubbed, so what is pinned is the CLI as an operator invokes it: the
 * flag each subcommand takes, which note or sync the host is asked for, what reaches each
 * output channel, and which code the action hands to `deps.exit`.
 *
 * No mirror is read: the host is a stub at the dependency seam, and the note it answers with
 * is serialized by the package's own `serializeMemoryNote`, so the text a `show` prints is
 * compared with the encoding the store writes rather than with a hand-copied literal. The
 * sync lines are spelled out in full — a line compared against the formatter that produced it
 * would pass even if both were wrong.
 */

import { describe, expect, test } from "bun:test";
import { type MemoryNote, type MemoryScope, type MemorySyncResult, serializeMemoryNote } from "@nathapp/nax-agent";
import { assertDefined, makeNaxConfig } from "@test/helpers";
import { Command } from "commander";
import { type MemoryCliDeps, registerMemoryCommand } from "@/cli";
import type { CreateMemoryHostInput, MemoryHost } from "@/memory";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The note `show staging-db` prints: the project's own, as a session saved it. */
const PROJECT_NOTE: MemoryNote = {
  id: "nax-chat",
  slug: "staging-db",
  type: "project",
  scope: "project",
  description: "shared staging db",
  source: "nax-chat",
  updatedAt: "2026-11-02T08:11:00.000Z",
  status: "active",
  body: "the body of staging-db",
};

/** The note `show pref --scope user` prints: the machine's, written by a person. */
const USER_NOTE: MemoryNote = {
  ...PROJECT_NOTE,
  id: "human-pref",
  slug: "pref",
  scope: "user",
  source: "human",
  description: "terse replies",
  body: "the body of pref",
};

/** A run that moved everything it had: the ordinary sync. */
const SYNCED: MemorySyncResult = { outcome: "synced", pushed: 1, rejected: 0, pulled: 2, skipped: 0 };

/** A run the provider was not reachable for: nothing moved, and nothing went wrong. */
const UNREACHABLE: MemorySyncResult = { outcome: "unreachable", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };

/** A run another writer held the lock for: the next open will try again. */
const LOCKED: MemorySyncResult = { outcome: "locked", pushed: 0, rejected: 0, pulled: 0, skipped: 0 };

/** A run that ended in an error: the one outcome the CLI reports as a failure. */
const FAILED: MemorySyncResult = {
  outcome: "failed",
  pushed: 0,
  rejected: 0,
  pulled: 0,
  skipped: 0,
  error: "lock busy",
};

/** What a `getNote` call was asked for, in call order. */
interface NoteQuery {
  readonly scope: MemoryScope;
  readonly slug: string;
}

/** The two reads this file drives, recorded so a case can assert what the host was asked. */
interface HostCalls {
  readonly getNote: NoteQuery[];
  sync: number;
}

/** The note and the result the stubbed host answers with; each case varies only what it reads. */
interface HostFixture {
  readonly notes?: readonly MemoryNote[];
  readonly result?: MemorySyncResult;
}

/** A `MemoryHost` whose `getNote` and `sync` this file drives; every other member is unread. */
function fakeHost(notes: readonly MemoryNote[], result: MemorySyncResult, calls: HostCalls): MemoryHost {
  const unread = async (): Promise<never> => {
    throw new Error("this test reads only getNote and sync");
  };
  return {
    dirs: { root: "/m", projectDir: "/m/projects/p", userDir: "/m/user" },
    providerId: "local",
    writeMode: "direct",
    notes: unread,
    getNote: async (scope, slug) => {
      calls.getNote.push({ scope, slug });
      return notes.find((note) => note.scope === scope && note.slug === slug) ?? null;
    },
    search: unread,
    renderIndex: unread,
    status: unread,
    sync: async () => {
      calls.sync += 1;
      return result;
    },
    save: unread,
    forget: unread,
    approve: unread,
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
  /** What the host was asked for. */
  readonly calls: HostCalls;
  /** What each `createMemoryHost` call was given. */
  readonly hostCalls: CreateMemoryHostInput[];
}

/** The CLI with every external call stubbed: a repository with no `.nax` above `--dir`. */
function harness(over: Partial<MemoryCliDeps> = {}, host: HostFixture = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const calls: HostCalls = { getNote: [], sync: 0 };
  const hostCalls: CreateMemoryHostInput[] = [];
  const notes = host.notes ?? [PROJECT_NOTE, USER_NOTE];
  const result = host.result ?? SYNCED;
  const deps: MemoryCliDeps = {
    log: (msg) => out.push(msg),
    logErr: (msg) => err.push(msg),
    exit: (code) => codes.push(code),
    findProjectDir: () => null,
    loadConfig: async () => makeNaxConfig(),
    createMemoryHost: async (input) => {
      hostCalls.push(input);
      return fakeHost(notes, result, calls);
    },
    readFile: async () => "",
    ...over,
  };
  return { deps, out, err, codes, calls, hostCalls };
}

/** `nax memory <args>` through a program the group registered itself on. */
async function runMemory(h: Harness, args: readonly string[]): Promise<void> {
  const program = new Command();
  registerMemoryCommand(program, h.deps);
  await program.parseAsync(["node", "nax", "memory", ...args]);
}

// ─── show ────────────────────────────────────────────────────────────────────

describe("nax memory show", () => {
  test("AC-1: prints serializeMemoryNote of the note and exits 0", async () => {
    const h = harness();
    await runMemory(h, ["show", "staging-db"]);
    expect(h.out).toEqual([serializeMemoryNote(PROJECT_NOTE)]);
    expect(h.codes).toEqual([0]);
    expect(h.err).toEqual([]);
  });

  test("AC-2: an absent note is Error: no memory note project/absent, exit 1", async () => {
    const h = harness();
    await runMemory(h, ["show", "absent"]);
    expect(h.err).toEqual(["Error: no memory note project/absent"]);
    expect(h.codes).toEqual([1]);
  });

  test("AC-3: an absent note prints nothing to stdout", async () => {
    const h = harness();
    await runMemory(h, ["show", "absent"]);
    expect(h.out).toEqual([]);
  });

  test("AC-4: --scope user asks the host for the user note", async () => {
    const h = harness();
    await runMemory(h, ["show", "pref", "--scope", "user"]);
    expect(h.calls.getNote).toEqual([{ scope: "user", slug: "pref" }]);
    expect(h.out).toEqual([serializeMemoryNote(USER_NOTE)]);
    expect(h.codes).toEqual([0]);
  });

  test("AC-5: --json prints the note as one document whose body is the note's body", async () => {
    const h = harness();
    await runMemory(h, ["show", "staging-db", "--json"]);
    expect(h.out).toHaveLength(1);
    const printed: MemoryNote = JSON.parse(h.out[0] ?? "");
    expect(printed).toEqual(PROJECT_NOTE);
    expect(printed.body).toBe(PROJECT_NOTE.body);
    expect(h.codes).toEqual([0]);
  });

  test("AC-11: with memory disabled, show refuses and exits 1", async () => {
    const h = harness({ createMemoryHost: async () => null });
    await runMemory(h, ["show", "x"]);
    expect(h.err).toEqual(["Error: memory is disabled (memory.enabled is false)"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("an unknown --scope is an Error naming it, before any note is read", async () => {
    const h = harness();
    await runMemory(h, ["show", "staging-db", "--scope", "galaxy"]);
    const line = h.err[0] ?? "";
    expect(line.startsWith("Error:")).toBe(true);
    expect(line).toContain("galaxy");
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
    expect(h.calls.getNote).toEqual([]);
  });
});

// ─── sync ────────────────────────────────────────────────────────────────────

describe("nax memory sync", () => {
  test("AC-6: prints the result line and exits 0 for synced", async () => {
    const h = harness();
    await runMemory(h, ["sync"]);
    expect(h.out).toEqual(["memory sync: synced (pushed 1, rejected 0, pulled 2, skipped 0)"]);
    expect(h.codes).toEqual([0]);
    expect(h.err).toEqual([]);
    expect(h.calls.sync).toBe(1);
  });

  test("AC-7: exits 0 for unreachable", async () => {
    const h = harness({}, { result: UNREACHABLE });
    await runMemory(h, ["sync"]);
    expect(h.out).toEqual(["memory sync: unreachable"]);
    expect(h.codes).toEqual([0]);
    expect(h.err).toEqual([]);
  });

  test("AC-8: exits 1 for failed", async () => {
    const h = harness({}, { result: FAILED });
    await runMemory(h, ["sync"]);
    expect(h.codes).toEqual([1]);
  });

  test("AC-9: for failed, the result line is printed anyway", async () => {
    const h = harness({}, { result: FAILED });
    await runMemory(h, ["sync"]);
    expect(h.out).toEqual(["memory sync: failed: lock busy"]);
    expect(h.err).toEqual([]);
  });

  test("AC-10: --json prints the MemorySyncResult as one document", async () => {
    const h = harness({}, { result: FAILED });
    await runMemory(h, ["sync", "--json"]);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] ?? "")).toEqual(FAILED);
    expect(h.codes).toEqual([1]);
  });

  test("AC-12: with memory disabled, sync refuses and exits 1", async () => {
    const h = harness({ createMemoryHost: async () => null });
    await runMemory(h, ["sync"]);
    expect(h.err).toEqual(["Error: memory is disabled (memory.enabled is false)"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("a locked run is a state, not a failure: it prints and exits 0", async () => {
    const h = harness({}, { result: LOCKED });
    await runMemory(h, ["sync"]);
    expect(h.out).toEqual(["memory sync: locked"]);
    expect(h.codes).toEqual([0]);
  });
});

// ─── the shared flags ────────────────────────────────────────────────────────

describe("the flags both read subcommands share", () => {
  test("--dir roots the host at the directory given, on show and on sync", async () => {
    const show = harness();
    await runMemory(show, ["show", "staging-db", "--dir", "/elsewhere"]);
    const sync = harness();
    await runMemory(sync, ["sync", "--dir", "/elsewhere"]);
    expect(show.hostCalls.map((call) => call.repoRoot)).toEqual(["/elsewhere"]);
    expect(sync.hostCalls.map((call) => call.repoRoot)).toEqual(["/elsewhere"]);
  });
});

// ─── registration ────────────────────────────────────────────────────────────

describe("registerMemoryCommand", () => {
  test("AC-13: the memory group's subcommands include show and sync", () => {
    const program = new Command();
    registerMemoryCommand(program, harness().deps);
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
