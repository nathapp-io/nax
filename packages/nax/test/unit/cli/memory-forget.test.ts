/**
 * US-019 — `nax memory forget` and `nax memory approve`.
 *
 * Every case enters through `program.parseAsync(["node", "nax", "memory", …])` with the
 * `MemoryCliDeps` seam stubbed, so what is pinned is the CLI as an operator invokes it: the
 * flags each subcommand takes, which note the host is asked to retire or put in force, what
 * reaches each output channel, and which code the action hands to `deps.exit`.
 *
 * No mirror is written: the host is a stub at the dependency seam, so the write is what is
 * observed — the request it was given, and how its answer is reported. Both refusals a write
 * can meet are driven by throwing the error the host itself throws — the repository's
 * read-only refusal, and feature 1's absent-note code — so the cases pin the CLI's
 * pass-through and its one re-wording rather than a translated message of its own.
 */

import { describe, expect, test } from "bun:test";
import type { MemoryForgetResult, MemoryNote, MemoryScope } from "@nathapp/nax-agent";
import { MEMORY_FORGET_REASON_MAX_CHARS } from "@nathapp/nax-agent";
import { assertDefined, makeNaxConfig } from "@test/helpers";
import { Command } from "commander";
import { type MemoryCliDeps, registerMemoryCommand } from "@/cli";
import { NaxError } from "@/errors";
import type { CreateMemoryHostInput, MemoryHost } from "@/memory";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A delivered forget: the note is gone from the mirror and the provider took the retire. */
const DELETED: MemoryForgetResult = { slug: "old", status: "deleted", delivered: true };

/** The note `approve replay-budget` puts in force: pending until the terminal approved it. */
const REPLAY_BUDGET: MemoryNote = {
  id: "nax-chat",
  slug: "replay-budget",
  type: "project",
  scope: "project",
  description: "replay budget",
  source: "nax-chat",
  updatedAt: "2026-11-02T08:11:00.000Z",
  status: "active",
  body: "2048 MiB",
};

/** The refusal the host raises for a slug only a repository note holds. */
const READ_ONLY = new NaxError(
  'memory note "staging-db" is a repository note; edit .nax/memory/staging-db.md in the repository',
  "MEMORY_NOTE_READ_ONLY",
  { stage: "memory", slug: "staging-db" },
);

/** The refusal feature 1 raises for a slug the mirror does not hold. */
const NOT_FOUND = new NaxError('memory note "project/absent" is not in this mirror', "MEMORY_NOTE_NOT_FOUND", {
  stage: "memory",
  scope: "project",
  slug: "absent",
});

/** One forget request, as the CLI handed it to the host. */
interface ForgetRequest {
  readonly scope: MemoryScope;
  readonly slug: string;
  readonly reason: string;
}

/** One approve request, as the CLI handed it to the host. */
interface ApproveRequest {
  readonly scope: MemoryScope;
  readonly slug: string;
}

/** What the stubbed host answers with: a result, or the refusal a write throws. */
interface HostFixture {
  readonly forgotten?: MemoryForgetResult;
  readonly approved?: MemoryNote;
  readonly throws?: Error;
}

/** The two writes this file drives, recorded so a case can assert what the host was asked. */
interface HostCalls {
  readonly forget: ForgetRequest[];
  readonly approve: ApproveRequest[];
}

/** A `MemoryHost` whose `forget` and `approve` this file drives; every other member is unread. */
function fakeHost(fixture: HostFixture, calls: HostCalls): MemoryHost {
  const unread = async (): Promise<never> => {
    throw new Error("this test reads only forget and approve");
  };
  const refuse = (): never => {
    throw fixture.throws;
  };
  return {
    dirs: { root: "/m", projectDir: "/m/projects/p", userDir: "/m/user" },
    providerId: "local",
    writeMode: "direct",
    notes: unread,
    getNote: unread,
    search: unread,
    renderIndex: unread,
    status: unread,
    sync: unread,
    save: unread,
    forget: async (request) => {
      calls.forget.push(request);
      if (fixture.throws !== undefined) return refuse();
      return fixture.forgotten ?? DELETED;
    },
    approve: async (request) => {
      calls.approve.push(request);
      if (fixture.throws !== undefined) return refuse();
      return fixture.approved ?? REPLAY_BUDGET;
    },
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
  /** What the host was asked to write. */
  readonly calls: HostCalls;
  /** What each `createMemoryHost` call was given. */
  readonly hostCalls: CreateMemoryHostInput[];
}

/** The CLI with every external call stubbed: a repository with no `.nax` above `--dir`. */
function harness(over: Partial<MemoryCliDeps> = {}, fixture: HostFixture = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const calls: HostCalls = { forget: [], approve: [] };
  const hostCalls: CreateMemoryHostInput[] = [];
  const deps: MemoryCliDeps = {
    log: (msg) => out.push(msg),
    logErr: (msg) => err.push(msg),
    exit: (code) => codes.push(code),
    findProjectDir: () => null,
    loadConfig: async () => makeNaxConfig(),
    createMemoryHost: async (input) => {
      hostCalls.push(input);
      return fakeHost(fixture, calls);
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

// ─── forget ──────────────────────────────────────────────────────────────────

describe("nax memory forget", () => {
  test("AC-1: calls host.forget with the project scope, the slug and the reason", async () => {
    const h = harness();
    await runMemory(h, ["forget", "old", "--reason", "stale"]);
    expect(h.calls.forget).toEqual([{ scope: "project", slug: "old", reason: "stale" }]);
    expect(h.codes).toEqual([0]);
  });

  test("AC-2: a deleted forget prints forgot project/old (deleted) and exits 0", async () => {
    const h = harness();
    await runMemory(h, ["forget", "old", "--reason", "stale"]);
    expect(h.out).toEqual(["forgot project/old (deleted)"]);
    expect(h.codes).toEqual([0]);
    expect(h.err).toEqual([]);
  });

  test("AC-3: without --reason it exits 1", async () => {
    const h = harness();
    await runMemory(h, ["forget", "old"]);
    expect(h.codes).toEqual([1]);
  });

  test("AC-4: without --reason host.forget is not called", async () => {
    const h = harness();
    await runMemory(h, ["forget", "old"]);
    expect(h.calls.forget).toEqual([]);
    expect(h.hostCalls).toEqual([]);
    expect(h.out).toEqual([]);
  });

  test("AC-5: a MEMORY_NOTE_READ_ONLY is an Error: line carrying its message, exit 1", async () => {
    const h = harness({}, { throws: READ_ONLY });
    await runMemory(h, ["forget", "staging-db", "--reason", "x"]);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]?.startsWith("Error:")).toBe(true);
    expect(h.err[0]).toContain(READ_ONLY.message);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("AC-6: a MEMORY_NOTE_NOT_FOUND reads Error: no memory note project/<slug>, exit 1", async () => {
    const h = harness({}, { throws: NOT_FOUND });
    await runMemory(h, ["forget", "absent", "--reason", "stale"]);
    expect(h.err).toEqual(["Error: no memory note project/absent"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("AC-7: --json prints the forget result as one document", async () => {
    const h = harness({}, { forgotten: { slug: "old", status: "pending", delivered: false } });
    await runMemory(h, ["forget", "old", "--reason", "stale", "--json"]);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] ?? "")).toEqual({ slug: "old", status: "pending", delivered: false });
    expect(h.codes).toEqual([0]);
  });

  test("AC-12: with memory disabled, forget refuses and exits 1", async () => {
    const h = harness({ createMemoryHost: async () => null });
    await runMemory(h, ["forget", "x", "--reason", "y"]);
    expect(h.err).toEqual(["Error: memory is disabled (memory.enabled is false)"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("--scope user forgets in the user mirror", async () => {
    const h = harness();
    await runMemory(h, ["forget", "old", "--reason", "stale", "--scope", "user"]);
    expect(h.calls.forget).toEqual([{ scope: "user", slug: "old", reason: "stale" }]);
    expect(h.out).toEqual(["forgot user/old (deleted)"]);
    expect(h.codes).toEqual([0]);
  });

  test("a blank --reason is a usage error naming the flag, before the host is opened", async () => {
    const h = harness();
    await runMemory(h, ["forget", "old", "--reason", "  "]);
    const line = h.err[0] ?? "";
    expect(line.startsWith("Error:")).toBe(true);
    expect(line).toContain("--reason");
    expect(h.codes).toEqual([1]);
    expect(h.calls.forget).toEqual([]);
    expect(h.hostCalls).toEqual([]);
  });

  test("[F1] a reason over the store's cap is a usage error naming the cap, before the host is opened", async () => {
    const h = harness();
    await runMemory(h, ["forget", "old", "--reason", "a".repeat(MEMORY_FORGET_REASON_MAX_CHARS + 1)]);
    const line = h.err[0] ?? "";
    expect(line.startsWith("Error:")).toBe(true);
    expect(line).toBe(`Error: forget reason must be at most ${MEMORY_FORGET_REASON_MAX_CHARS} characters`);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
    expect(h.calls.forget).toEqual([]);
    expect(h.hostCalls).toEqual([]);
  });

  test("[F1] a reason of exactly the cap is handed to the host unchanged", async () => {
    const h = harness();
    const atCap = "a".repeat(MEMORY_FORGET_REASON_MAX_CHARS);
    await runMemory(h, ["forget", "old", "--reason", atCap]);
    expect(h.calls.forget).toEqual([{ scope: "project", slug: "old", reason: atCap }]);
    expect(h.codes).toEqual([0]);
    expect(h.err).toEqual([]);
  });

  test("--dir roots the host at the directory given", async () => {
    const h = harness();
    await runMemory(h, ["forget", "old", "--reason", "stale", "--dir", "/elsewhere"]);
    expect(h.hostCalls.map((call) => call.repoRoot)).toEqual(["/elsewhere"]);
  });
});

// ─── approve ─────────────────────────────────────────────────────────────────

describe("nax memory approve", () => {
  test("AC-8: calls host.approve with the project scope and the slug", async () => {
    const h = harness();
    await runMemory(h, ["approve", "replay-budget"]);
    expect(h.calls.approve).toEqual([{ scope: "project", slug: "replay-budget" }]);
    expect(h.codes).toEqual([0]);
  });

  test("AC-9: prints approved project/replay-budget and exits 0", async () => {
    const h = harness();
    await runMemory(h, ["approve", "replay-budget"]);
    expect(h.out).toEqual(["approved project/replay-budget"]);
    expect(h.codes).toEqual([0]);
    expect(h.err).toEqual([]);
  });

  test("AC-10: a MEMORY_NOTE_NOT_FOUND reads Error: no memory note project/<slug>, exit 1", async () => {
    const h = harness({}, { throws: NOT_FOUND });
    await runMemory(h, ["approve", "absent"]);
    expect(h.err).toEqual(["Error: no memory note project/absent"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("AC-11: a MEMORY_NOTE_READ_ONLY exits 1", async () => {
    const h = harness({}, { throws: READ_ONLY });
    await runMemory(h, ["approve", "staging-db"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
    expect(h.err[0]?.startsWith("Error:")).toBe(true);
  });

  test("AC-13: with memory disabled, approve refuses and exits 1", async () => {
    const h = harness({ createMemoryHost: async () => null });
    await runMemory(h, ["approve", "x"]);
    expect(h.err).toEqual(["Error: memory is disabled (memory.enabled is false)"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("--json prints the approved note as one document", async () => {
    const h = harness();
    await runMemory(h, ["approve", "replay-budget", "--json"]);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] ?? "")).toEqual(REPLAY_BUDGET);
    expect(h.codes).toEqual([0]);
  });

  test("--scope user approves in the user mirror", async () => {
    const h = harness({}, { approved: { ...REPLAY_BUDGET, id: "human-pref", slug: "pref", scope: "user" } });
    await runMemory(h, ["approve", "pref", "--scope", "user"]);
    expect(h.calls.approve).toEqual([{ scope: "user", slug: "pref" }]);
    expect(h.out).toEqual(["approved user/pref"]);
    expect(h.codes).toEqual([0]);
  });

  test("an unknown --scope is an Error naming it, before the host is opened", async () => {
    const h = harness();
    await runMemory(h, ["approve", "replay-budget", "--scope", "galaxy"]);
    const line = h.err[0] ?? "";
    expect(line.startsWith("Error:")).toBe(true);
    expect(line).toContain("galaxy");
    expect(h.codes).toEqual([1]);
    expect(h.calls.approve).toEqual([]);
    expect(h.hostCalls).toEqual([]);
  });
});

// ─── registration ────────────────────────────────────────────────────────────

describe("registerMemoryCommand — the retirement subcommands", () => {
  test("AC-14: the group's subcommands include save, forget and approve", () => {
    const program = new Command();
    registerMemoryCommand(program, harness().deps);
    const memory = program.commands.find((command) => command.name() === "memory");
    assertDefined(memory, "the memory command");
    const names = memory.commands.map((command) => command.name());
    expect(names).toEqual(["status", "list", "show", "sync", "save", "forget", "approve"]);
    expect(names).toContain("save");
    expect(names).toContain("forget");
    expect(names).toContain("approve");
  });
});
