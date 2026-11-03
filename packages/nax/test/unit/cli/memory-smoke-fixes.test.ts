/**
 * US-004 — the memory list's markers and empty states, and the approval's three outcomes.
 *
 * Two smoke fixes from the terminal: `nax memory list` printed nothing over an empty mirror,
 * and `nax memory approve` printed `approved …` whether it approved a pending note, found one
 * already in force, or completed a queued forget. Both are what the CLI reports, so every case
 * enters through `program.parseAsync(["node", "nax", "memory", …])` with the `MemoryCliDeps`
 * seam stubbed and the host a double — what is pinned is the line the operator reads and the
 * code the action hands to `deps.exit`.
 *
 * The double records the order `getNote` and `approve` are called in, because the message
 * depends on the note as it was before the approval and the approval is still what changes it.
 * A case that needs a host without `forgetPendingKeys` builds one: the member is optional so a
 * hand-built double stays valid, and a listing must then print its rows unmarked.
 */

import { describe, expect, test } from "bun:test";
import type { MemoryNote, MemoryScope } from "@nathapp/nax-agent";
import { makeNaxConfig } from "@test/helpers";
import { Command } from "commander";
import { _memoryCliDeps, type MemoryCliDeps, registerMemoryCommand } from "@/cli";
import { NaxError } from "@/errors";
import { type CreateMemoryHostInput, formatMemoryNoteLine, type MemoryHost } from "@/memory";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** One note, filled in; each case varies the field it marks, filters or prints. */
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

/** The note a listing marks: `project/a`, active, with a forget the host reports as pending. */
const NOTE_A = note({ slug: "a", description: "the a note" });

/** A second note, so a case can show every row printed rather than only the first. */
const NOTE_B = note({ slug: "b", description: "the b note" });

/** The refusal feature 1 raises for a slug the mirror does not hold. */
const NOT_FOUND = new NaxError('memory note "project/absent" is not in this mirror', "MEMORY_NOTE_NOT_FOUND", {
  stage: "memory",
  scope: "project",
  slug: "absent",
});

/** What the stubbed host answers with, and how. */
interface HostFixture {
  readonly projectNotes?: readonly MemoryNote[];
  readonly userNotes?: readonly MemoryNote[];
  /** Omit it to build a host with no `forgetPendingKeys` member at all. */
  readonly forgetPending?: ReadonlySet<string>;
  /** What `getNote` resolves to: the note as it was before the approval. */
  readonly before?: MemoryNote | null;
  /** What `approve` resolves to. */
  readonly approved?: MemoryNote;
  /** What `approve` throws instead of resolving. */
  readonly throws?: Error;
}

/** The two calls an approval makes, in the order it made them: `getNote` reads, `approve` writes. */
interface HostCalls {
  readonly order: string[];
  readonly getNote: { readonly scope: MemoryScope; readonly slug: string }[];
  readonly approve: { readonly scope: MemoryScope; readonly slug: string }[];
}

/** A `MemoryHost` whose listing and approval members this file drives; the rest are unread. */
function fakeHost(fixture: HostFixture, calls: HostCalls): MemoryHost {
  const unread = async (): Promise<never> => {
    throw new Error("this test reads only the listing and the approval");
  };
  const listing: MemoryHost = {
    dirs: { root: "/m", projectDir: "/m/projects/p", userDir: "/m/user" },
    providerId: "local",
    writeMode: "direct",
    notes: async (scope) => (scope === "project" ? (fixture.projectNotes ?? []) : (fixture.userNotes ?? [])),
    getNote: async (scope, slug) => {
      calls.order.push("getNote");
      calls.getNote.push({ scope, slug });
      return fixture.before ?? null;
    },
    search: unread,
    renderIndex: unread,
    sync: unread,
    status: unread,
    save: unread,
    forget: unread,
    approve: async (request) => {
      calls.order.push("approve");
      calls.approve.push(request);
      if (fixture.throws !== undefined) throw fixture.throws;
      return fixture.approved ?? NOTE_A;
    },
  };
  return fixture.forgetPending === undefined
    ? listing
    : { ...listing, forgetPendingKeys: async () => fixture.forgetPending ?? new Set<string>() };
}

interface Harness {
  readonly deps: MemoryCliDeps;
  /** stdout lines. */
  readonly out: string[];
  /** stderr lines. */
  readonly err: string[];
  /** Every code handed to `exit`, in order. */
  readonly codes: number[];
  /** What the host was asked, in order. */
  readonly calls: HostCalls;
  /** What each `createMemoryHost` call was given. */
  readonly hostCalls: CreateMemoryHostInput[];
}

/** The CLI with every external call stubbed: a repository with no `.nax` above `--dir`. */
function harness(fixture: HostFixture = {}, over: Partial<MemoryCliDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const hostCalls: CreateMemoryHostInput[] = [];
  const calls: HostCalls = { order: [], getNote: [], approve: [] };
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

// ─── list ────────────────────────────────────────────────────────────────────

describe("nax memory list — markers and empty states", () => {
  test("AC-4: a row whose key the host reports as pending a forget carries the marker", async () => {
    const h = harness({ projectNotes: [NOTE_A], forgetPending: new Set(["project/a"]) });

    await runMemory(h, ["list"]);

    expect(h.out).toEqual([`${formatMemoryNoteLine(NOTE_A)} (forget pending)`]);
  });

  test("AC-5: a host with no forgetPendingKeys logs each row unmarked", async () => {
    const h = harness({ projectNotes: [NOTE_A, NOTE_B] });

    await runMemory(h, ["list"]);

    expect(h.out).toEqual([formatMemoryNoteLine(NOTE_A), formatMemoryNoteLine(NOTE_B)]);
  });

  test("AC-6: a host with no forgetPendingKeys returns 0", async () => {
    const h = harness({ projectNotes: [NOTE_A, NOTE_B] });

    await runMemory(h, ["list"]);

    expect(h.codes).toEqual([0]);
  });

  test("AC-7: an empty mirror with no filter logs no memory notes", async () => {
    const h = harness();

    await runMemory(h, ["list"]);

    expect(h.out).toEqual(["no memory notes"]);
  });

  test("AC-8: an empty mirror with no filter returns 0", async () => {
    const h = harness();

    await runMemory(h, ["list"]);

    expect(h.codes).toEqual([0]);
  });

  test("AC-9: --type over a note of another type logs no memory notes match", async () => {
    const h = harness({ projectNotes: [NOTE_A] });

    await runMemory(h, ["list", "--type", "feedback"]);

    expect(h.out).toEqual(["no memory notes match"]);
  });

  test("AC-10: --type over a note of another type returns 0", async () => {
    const h = harness({ projectNotes: [NOTE_A] });

    await runMemory(h, ["list", "--type", "feedback"]);

    expect(h.codes).toEqual([0]);
  });

  test("AC-11: --json over an empty mirror prints the empty document", async () => {
    const h = harness();

    await runMemory(h, ["list", "--json"]);

    expect(h.out).toEqual(['{"notes":[]}']);
  });

  test("a scope filter that matches nothing says so, and is not the unfiltered wording", async () => {
    const h = harness({ projectNotes: [NOTE_A] });

    await runMemory(h, ["list", "--scope", "user"]);

    expect(h.out).toEqual(["no memory notes match"]);
  });
});

// ─── approve ─────────────────────────────────────────────────────────────────

describe("nax memory approve — the three outcomes", () => {
  test("AC-12: a note already in force says so instead of claiming an approval", async () => {
    const h = harness({ before: NOTE_A, approved: NOTE_A });

    await runMemory(h, ["approve", "a"]);

    expect(h.out).toEqual(["project/a is already active; nothing to approve"]);
  });

  test("AC-13: a note already in force returns 0", async () => {
    const h = harness({ before: NOTE_A, approved: NOTE_A });

    await runMemory(h, ["approve", "a"]);

    expect(h.codes).toEqual([0]);
  });

  test("AC-14: an approval that retired the note reports the forget it completed", async () => {
    const h = harness({ before: NOTE_A, approved: { ...NOTE_A, status: "deleted" } });

    await runMemory(h, ["approve", "a"]);

    expect(h.out).toEqual(["forgot project/a (forget approved)"]);
  });

  test("AC-15: an approval that retired the note returns 0", async () => {
    const h = harness({ before: NOTE_A, approved: { ...NOTE_A, status: "deleted" } });

    await runMemory(h, ["approve", "a"]);

    expect(h.codes).toEqual([0]);
  });

  test("AC-16: a pending note approved into force prints the approval", async () => {
    const h = harness({ before: { ...NOTE_A, status: "pending" }, approved: NOTE_A });

    await runMemory(h, ["approve", "a"]);

    expect(h.out).toEqual(["approved project/a"]);
  });

  test("AC-17: the note is read through getNote with the scope and slug before approve is called", async () => {
    const h = harness({ before: NOTE_A, approved: NOTE_A });

    await runMemory(h, ["approve", "a"]);

    expect(h.calls.order).toEqual(["getNote", "approve"]);
    expect(h.calls.getNote).toEqual([{ scope: "project", slug: "a" }]);
  });

  test("AC-18: an absent note still goes to the host's own approval", async () => {
    const h = harness({ before: null, throws: NOT_FOUND });

    await runMemory(h, ["approve", "absent"]);

    expect(h.calls.approve).toEqual([{ scope: "project", slug: "absent" }]);
  });

  test("AC-19: an absent note reads Error: no memory note project/absent on stderr", async () => {
    const h = harness({ before: null, throws: NOT_FOUND });

    await runMemory(h, ["approve", "absent"]);

    expect(h.err).toEqual(["Error: no memory note project/absent"]);
  });

  test("AC-20: an absent note returns 1", async () => {
    const h = harness({ before: null, throws: NOT_FOUND });

    await runMemory(h, ["approve", "absent"]);

    expect(h.codes).toEqual([1]);
  });

  test("an approval announced with --json prints the note the store resolved", async () => {
    const h = harness({ before: { ...NOTE_A, status: "pending" }, approved: NOTE_A });

    await runMemory(h, ["approve", "a", "--json"]);

    expect(h.out).toEqual([JSON.stringify(NOTE_A)]);
  });

  test("--scope user reads and approves in the user mirror", async () => {
    const h = harness({
      before: { ...NOTE_A, scope: "user", status: "pending" },
      approved: { ...NOTE_A, scope: "user" },
    });

    await runMemory(h, ["approve", "a", "--scope", "user"]);

    expect({ getNote: h.calls.getNote, approve: h.calls.approve, out: h.out }).toEqual({
      getNote: [{ scope: "user", slug: "a" }],
      approve: [{ scope: "user", slug: "a" }],
      out: ["approved user/a"],
    });
  });
});

// ─── the seam ────────────────────────────────────────────────────────────────

describe("the memory command's registration", () => {
  test("the group's subcommands still include the listing and the approval", () => {
    const program = new Command();
    registerMemoryCommand(program, harness().deps);
    const memory = program.commands.find((command) => command.name() === "memory");
    expect(memory?.commands.map((command) => command.name())).toEqual([
      "status",
      "list",
      "show",
      "sync",
      "save",
      "forget",
      "approve",
    ]);
    expect(typeof _memoryCliDeps.createMemoryHost).toBe("function");
  });
});
