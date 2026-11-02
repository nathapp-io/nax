/**
 * US-018 — `nax memory save`.
 *
 * Every case enters through `program.parseAsync(["node", "nax", "memory", …])` with the
 * `MemoryCliDeps` seam stubbed, so what is pinned is the CLI as an operator invokes it: the
 * flags `save` takes, the note it hands the host, what reaches each output channel, and which
 * code the action hands to `deps.exit`.
 *
 * No mirror is written: the host is a stub at the dependency seam, so `save` is what is
 * observed — the `MemoryNoteWrite` it was given, and how its answer is reported. A refusal is
 * driven by throwing the error the store itself throws (`MEMORY_WRITE_REFUSED`), so the case
 * pins the CLI's pass-through rather than a translated message.
 */

import { describe, expect, test } from "bun:test";
import type { MemoryNoteWrite, MemorySaveResult } from "@nathapp/nax-agent";
import { makeNaxConfig } from "@test/helpers";
import { Command } from "commander";
import { type MemoryCliDeps, registerMemoryCommand } from "@/cli";
import { NaxError } from "@/errors";
import type { CreateMemoryHostInput, MemoryHost } from "@/memory";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The note `save --slug replay-budget …` writes, as the CLI hands it to the host. */
const REPLAY_BUDGET: MemoryNoteWrite = {
  slug: "replay-budget",
  type: "project",
  scope: "project",
  description: "replay budget",
  body: "2048 MiB",
};

/** A delivered save: the note is in the mirror and the provider took it. */
const DELIVERED: MemorySaveResult = { slug: "replay-budget", status: "active", delivered: true };

/** The one refusal the store raises for a note it will not keep. */
const REFUSAL = new NaxError("secret (aws) must not be stored", "MEMORY_WRITE_REFUSED", {
  stage: "memory",
  field: "body",
});

/** The refusal the store raises for a `--type` outside its vocabulary. */
const TYPE_REFUSAL = new NaxError("type must be one of user, feedback, project, reference", "MEMORY_WRITE_REFUSED", {
  stage: "memory",
  field: "type",
});

/** What the stubbed host answers with: a result, or the refusal a `save` throws. */
interface HostFixture {
  readonly result?: MemorySaveResult;
  readonly throws?: Error;
}

/** What the stubbed host was asked to save, in call order. */
interface HostCalls {
  readonly save: MemoryNoteWrite[];
}

/** A `MemoryHost` whose `save` this file drives; every other member is unread. */
function fakeHost(fixture: HostFixture, calls: HostCalls): MemoryHost {
  const unread = async (): Promise<never> => {
    throw new Error("this test reads only save");
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
    save: async (write) => {
      calls.save.push(write);
      if (fixture.throws !== undefined) throw fixture.throws;
      return fixture.result ?? DELIVERED;
    },
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
  /** What the host was asked to save. */
  readonly calls: HostCalls;
  /** What each `createMemoryHost` call was given. */
  readonly hostCalls: CreateMemoryHostInput[];
  /** Every path handed to `readFile`, in call order. */
  readonly readPaths: string[];
}

/** The CLI with every external call stubbed: a repository with no `.nax` above `--dir`. */
function harness(over: Partial<MemoryCliDeps> = {}, fixture: HostFixture = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const calls: HostCalls = { save: [] };
  const hostCalls: CreateMemoryHostInput[] = [];
  const readPaths: string[] = [];
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
    readFile: async (path) => {
      readPaths.push(path);
      return "the body of the note\n";
    },
    ...over,
  };
  return { deps, out, err, codes, calls, hostCalls, readPaths };
}

/** `nax memory <args>` through a program the group registered itself on. */
async function runMemory(h: Harness, args: readonly string[]): Promise<void> {
  const program = new Command();
  registerMemoryCommand(program, h.deps);
  await program.parseAsync(["node", "nax", "memory", ...args]);
}

/** The arguments AC-1 names, minus the two body inputs a case varies. */
const SAVE_ARGS = ["save", "--slug", "replay-budget", "--type", "project", "--description", "replay budget"];

// ─── the write ───────────────────────────────────────────────────────────────

describe("nax memory save", () => {
  test("AC-1: calls host.save with the note's fields and the project scope", async () => {
    const h = harness();
    await runMemory(h, [...SAVE_ARGS, "--body", "2048 MiB"]);
    expect(h.calls.save).toEqual([REPLAY_BUDGET]);
    expect(h.codes).toEqual([0]);
  });

  test("AC-2: a delivered active save prints saved project/replay-budget (active) and exits 0", async () => {
    const h = harness();
    await runMemory(h, [...SAVE_ARGS, "--body", "2048 MiB"]);
    expect(h.out).toEqual(["saved project/replay-budget (active)"]);
    expect(h.codes).toEqual([0]);
    expect(h.err).toEqual([]);
  });

  test("AC-3: --body-file reads the file through the seam and saves its text as the body", async () => {
    const h = harness();
    await runMemory(h, [...SAVE_ARGS, "--body-file", "note.md"]);
    expect(h.readPaths).toEqual(["note.md"]);
    expect(h.calls.save).toEqual([{ ...REPLAY_BUDGET, body: "the body of the note\n" }]);
    expect(h.codes).toEqual([0]);
  });

  test("AC-8: --scope user saves into the user mirror", async () => {
    const h = harness();
    await runMemory(h, [...SAVE_ARGS, "--body", "2048 MiB", "--scope", "user"]);
    expect(h.calls.save).toEqual([{ ...REPLAY_BUDGET, scope: "user" }]);
    expect(h.codes).toEqual([0]);
  });

  test("AC-9: a pending save prints its status", async () => {
    const h = harness({}, { result: { slug: "replay-budget", status: "pending", delivered: true } });
    await runMemory(h, [...SAVE_ARGS, "--body", "2048 MiB"]);
    expect(h.out).toEqual(["saved project/replay-budget (pending)"]);
    expect(h.codes).toEqual([0]);
  });

  test("AC-10: an undelivered save ends with the queued-for-sync note", async () => {
    const h = harness({}, { result: { slug: "replay-budget", status: "active", delivered: false } });
    await runMemory(h, [...SAVE_ARGS, "--body", "2048 MiB"]);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]?.endsWith(" — queued for sync")).toBe(true);
    expect(h.codes).toEqual([0]);
  });

  test("AC-11: --json prints the save result as one document", async () => {
    const h = harness({}, { result: { slug: "replay-budget", status: "pending", delivered: false } });
    await runMemory(h, [...SAVE_ARGS, "--body", "2048 MiB", "--json"]);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] ?? "")).toEqual({ slug: "replay-budget", status: "pending", delivered: false });
    expect(h.codes).toEqual([0]);
  });
});

// ─── the exactly-one body input ─────────────────────────────────────────────

describe("nax memory save — the body input", () => {
  test("AC-4: both --body and --body-file is Error: give exactly one of --body or --body-file, exit 1", async () => {
    const h = harness();
    await runMemory(h, [...SAVE_ARGS, "--body", "2048 MiB", "--body-file", "note.md"]);
    expect(h.err).toEqual(["Error: give exactly one of --body or --body-file"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("AC-5: with both given, host.save is not called", async () => {
    const h = harness();
    await runMemory(h, [...SAVE_ARGS, "--body", "2048 MiB", "--body-file", "note.md"]);
    expect(h.calls.save).toEqual([]);
    expect(h.hostCalls).toEqual([]);
    expect(h.readPaths).toEqual([]);
  });

  test("AC-6: neither --body nor --body-file is the same error and exit 1", async () => {
    const h = harness();
    await runMemory(h, SAVE_ARGS);
    expect(h.err).toEqual(["Error: give exactly one of --body or --body-file"]);
    expect(h.codes).toEqual([1]);
    expect(h.calls.save).toEqual([]);
    expect(h.hostCalls).toEqual([]);
  });
});

// ─── the failure contract ───────────────────────────────────────────────────

describe("nax memory save — failures", () => {
  test("AC-7: a MEMORY_WRITE_REFUSED is Error: <its message> on stderr, exit 1", async () => {
    const h = harness({}, { throws: REFUSAL });
    await runMemory(h, [...SAVE_ARGS, "--body", "AKIAIOSFODNN7EXAMPLE"]);
    expect(h.err).toEqual(["Error: secret (aws) must not be stored"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("AC-12: with memory disabled, save refuses and exits 1", async () => {
    const h = harness({ createMemoryHost: async () => null });
    await runMemory(h, [...SAVE_ARGS, "--body", "2048 MiB"]);
    expect(h.err).toEqual(["Error: memory is disabled (memory.enabled is false)"]);
    expect(h.codes).toEqual([1]);
    expect(h.out).toEqual([]);
  });

  test("an unknown --type is not filtered by the CLI: the store's own refusal surfaces", async () => {
    const h = harness({}, { throws: TYPE_REFUSAL });
    await runMemory(h, [
      "save",
      "--slug",
      "replay-budget",
      "--type",
      "galaxy",
      "--description",
      "replay budget",
      "--body",
      "2048 MiB",
    ]);
    // The flag's value reaches the store untouched — `String` because the store's own type
    // is narrower than what the operator can type, which is exactly why the store refuses it.
    expect(String(h.calls.save[0]?.type)).toBe("galaxy");
    expect(h.err).toEqual([`Error: ${TYPE_REFUSAL.message}`]);
    expect(h.codes).toEqual([1]);
  });

  test("an unknown --scope is an Error naming it, before any note is written", async () => {
    const h = harness();
    await runMemory(h, [...SAVE_ARGS, "--body", "2048 MiB", "--scope", "galaxy"]);
    const line = h.err[0] ?? "";
    expect(line.startsWith("Error:")).toBe(true);
    expect(line).toContain("galaxy");
    expect(h.codes).toEqual([1]);
    expect(h.calls.save).toEqual([]);
  });

  test("--dir roots the host at the directory given", async () => {
    const h = harness();
    await runMemory(h, [...SAVE_ARGS, "--body", "2048 MiB", "--dir", "/elsewhere"]);
    expect(h.hostCalls.map((call) => call.repoRoot)).toEqual(["/elsewhere"]);
  });
});

// ─── registration ───────────────────────────────────────────────────────────

describe("registerMemoryCommand — the write subcommands", () => {
  test("the memory group's subcommands include save after sync", () => {
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
  });
});
