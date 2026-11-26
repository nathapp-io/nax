/**
 * US-016 — `nax memory undo`: the terminal's way back from a compaction.
 *
 * Every case drives `memoryUndoCommand` (or the program `registerMemoryCommand` builds) with a
 * host whose only readable member is `undoCompaction`, so what is pinned is the surface: which
 * target the command asks for, whether `--force` travels with it, the one line a person reads,
 * the one document a `--json` consumer reads, and the exit code each refusal becomes.
 *
 * The two refusals an operator actually meets (`MEMORY_COMPACT_CHANGED`, `MEMORY_COMPACT_NOT_FOUND`)
 * are raised by the operation in `@nathapp/nax-agent`, so they are carried here as the operation
 * words them: the command adds no wording of its own, which is exactly what the cases check —
 * `Error: ` and the operation's own message, on stderr, with nothing on stdout.
 */
import { describe, expect, test } from "bun:test";
import type { MemoryUndoResult } from "@nathapp/nax-agent/internal";
import { assertDefined, makeFakeMemoryHost, makeNaxConfig } from "@test/helpers";
import { Command } from "commander";
import { type MemoryCliDeps, type MemoryUndoOptions, memoryUndoCommand, registerMemoryCommand } from "@/cli";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import type { MemoryHost } from "@/memory";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The directory `--dir` names in every stubbed case. */
const REPO_DIR = "/repo/my-repo";

/** The id the archive minted for the compaction under test. */
const COMPACT_ID = "20261125T101500Z-3fa2c1";

/** What one undo did: three notes written back, and one merged note removed. */
const UNDONE: MemoryUndoResult = { id: COMPACT_ID, restored: ["alpha", "beta", "gamma"], removed: ["delta-epsilon"] };

/** The line those counts become. */
const UNDONE_LINE = `Undid compaction ${COMPACT_ID}: restored 3 notes, removed 1`;

/** What one undo is asked: the id it names (absent for the newest open one) and whether it forces. */
type UndoRequest = Parameters<NonNullable<MemoryHost["undoCompaction"]>>[0];

/** A compaction that restored and removed nothing: the counts a person reads are the result's own. */
const NOTHING_UNDONE: MemoryUndoResult = { id: COMPACT_ID, restored: [], removed: [] };

/** The refusal an undo raises for a note that moved since the compaction ran. */
function changed(): NaxError {
  return new NaxError(
    `memory undo: compaction "${COMPACT_ID}" changed these notes since it ran: alpha, beta`,
    "MEMORY_COMPACT_CHANGED",
    { stage: "memory", id: COMPACT_ID },
  );
}

/** The refusal an undo raises for a target it cannot find. */
function notFound(): NaxError {
  return new NaxError(`memory undo: compaction "${COMPACT_ID}" is not in this mirror`, "MEMORY_COMPACT_NOT_FOUND", {
    stage: "memory",
    id: COMPACT_ID,
  });
}

/** The config every case loads. */
function undoConfig(): NaxConfig {
  return makeNaxConfig({ name: "my-repo" });
}

// ─── harness ─────────────────────────────────────────────────────────────────

/** What one case varies. Absent means the harness default, never a different shape. */
interface Fixture {
  /** What the undo answers; {@link UNDONE} by default. */
  readonly result?: MemoryUndoResult;
  /** Rejects the undo with this error instead of answering a result. */
  readonly reject?: Error;
  /** Composes a host with no `undoCompaction` member at all — the optional member's absent arm. */
  readonly noUndoMember?: boolean;
  /** Composes no host at all: `createMemoryHost` answers `null`, as a disabled mirror does. */
  readonly disabled?: boolean;
  readonly config?: NaxConfig;
}

/** Everything a case measures: the two output channels and every undo the run reached. */
interface Harness {
  readonly deps: MemoryCliDeps;
  /** stdout lines. */
  readonly out: string[];
  /** stderr lines. */
  readonly err: string[];
  /** Every code handed to `exit`. */
  readonly codes: number[];
  /** What each `undoCompaction` call was given. */
  readonly undoCalls: UndoRequest[];
}

/** The host a case is handed: everything but `undoCompaction` refuses to be read. */
function undoHost(fixture: Fixture, undoCalls: UndoRequest[]): MemoryHost {
  const base = makeFakeMemoryHost("nax memory undo reads only undoCompaction");
  if (fixture.noUndoMember === true) return base;
  return Object.assign(base, {
    undoCompaction: async (input: UndoRequest): Promise<MemoryUndoResult> => {
      undoCalls.push(input);
      if (fixture.reject !== undefined) throw fixture.reject;
      return fixture.result ?? UNDONE;
    },
  });
}

/** The CLI with every external call stubbed: a repository with no `.nax` above `--dir`. */
function harness(fixture: Fixture = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const undoCalls: UndoRequest[] = [];
  const host = undoHost(fixture, undoCalls);
  const deps: MemoryCliDeps = {
    log: (msg) => {
      out.push(msg);
    },
    logErr: (msg) => {
      err.push(msg);
    },
    exit: (code) => {
      codes.push(code);
    },
    findProjectDir: () => null,
    loadConfig: async () => fixture.config ?? undoConfig(),
    createMemoryHost: async () => (fixture.disabled === true ? null : host),
    readFile: async () => "",
  };
  return { deps, out, err, codes, undoCalls };
}

/** `nax memory undo [<id>]` with the given flags. */
function run(h: Harness, id?: string, opts: Partial<MemoryUndoOptions> = {}): Promise<number> {
  return memoryUndoCommand(id, { dir: REPO_DIR, ...opts }, h.deps);
}

// ─── the target ──────────────────────────────────────────────────────────────

describe("nax memory undo — the target it undoes", () => {
  test("AC-1: an explicit id is asked for without force", async () => {
    const h = harness();

    expect(await run(h, COMPACT_ID)).toBe(0);
    expect(h.undoCalls).toEqual([{ id: COMPACT_ID, force: false }]);
  });

  test("AC-3: no id asks for the newest open compaction, naming no id at all", async () => {
    const h = harness();

    expect(await run(h)).toBe(0);
    expect(h.undoCalls).toEqual([{ force: false }]);
    expect(Object.hasOwn(h.undoCalls[0] ?? {}, "id")).toBe(false);
  });

  test("AC-4: --force travels with the id", async () => {
    const h = harness();

    expect(await run(h, COMPACT_ID, { force: true })).toBe(0);
    expect(h.undoCalls).toEqual([{ id: COMPACT_ID, force: true }]);
  });
});

// ─── what it prints ──────────────────────────────────────────────────────────

describe("nax memory undo — what it prints", () => {
  test("AC-2: the line counts what the undo restored and removed, and it exits 0", async () => {
    const h = harness();

    expect(await run(h, COMPACT_ID)).toBe(0);
    expect(h.out).toEqual([UNDONE_LINE]);
    expect(h.err).toEqual([]);
  });

  test("a result that restored nothing still reports its own counts", async () => {
    const h = harness({ result: { id: COMPACT_ID, restored: [], removed: [] } });

    expect(await run(h, COMPACT_ID)).toBe(0);
    expect(h.out).toEqual([`Undid compaction ${COMPACT_ID}: restored 0 notes, removed 0`]);
  });
});

// ─── refusals ────────────────────────────────────────────────────────────────

describe("nax memory undo — the refusals", () => {
  test("AC-5: MEMORY_COMPACT_CHANGED is Error: <message> on stderr and exit 1", async () => {
    const h = harness({ reject: changed() });

    expect(await run(h, COMPACT_ID)).toBe(1);
    expect(h.err).toEqual([`Error: ${changed().message}`]);
    expect(h.out).toEqual([]);
  });

  test("AC-6: MEMORY_COMPACT_NOT_FOUND is Error: <message> on stderr and exit 1", async () => {
    const h = harness({ reject: notFound() });

    expect(await run(h, COMPACT_ID)).toBe(1);
    expect(h.err).toEqual([`Error: ${notFound().message}`]);
    expect(h.out).toEqual([]);
  });

  test("a superseded target is refused the same way when no id was named", async () => {
    const h = harness({ reject: notFound() });

    expect(await run(h)).toBe(1);
    expect(h.err).toEqual([`Error: ${notFound().message}`]);
  });

  test("a disabled mirror is Error: <message> and exit 1, with no undo attempted", async () => {
    const h = harness({ disabled: true });

    expect(await run(h, COMPACT_ID)).toBe(1);
    expect(h.err).toEqual(["Error: memory is disabled (memory.enabled is false)"]);
    expect(h.undoCalls).toEqual([]);
  });

  test("a host with no undo member is an error rather than a silent success", async () => {
    const h = harness({ noUndoMember: true });

    expect(await run(h, COMPACT_ID)).toBe(1);
    expect(h.err).toEqual(["Error: memory undo is not available on this memory host"]);
    expect(h.out).toEqual([]);
  });
});

// ─── the machine-readable document ───────────────────────────────────────────

describe("nax memory undo --json", () => {
  test("AC-7: the result is one document on stdout and nothing else", async () => {
    const h = harness();

    expect(await run(h, COMPACT_ID, { json: true })).toBe(0);
    expect(h.out).toEqual([JSON.stringify(UNDONE)]);
    expect(h.err).toEqual([]);
  });

  test("an empty result is still exactly one document", async () => {
    const h = harness({ result: NOTHING_UNDONE });

    await run(h, COMPACT_ID, { json: true });

    expect(h.out).toEqual([JSON.stringify(NOTHING_UNDONE)]);
  });
});

// ─── registration ────────────────────────────────────────────────────────────

describe("registerMemoryCommand — undo", () => {
  test("AC-8: undo is registered directly after compact, every earlier subcommand preserved", () => {
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
      "requeue",
      "discard",
      "compact",
      "undo",
      "mirrors",
    ]);
  });

  describe("through the group's own deps", () => {
    test("AC-8: the undo action runs through the deps the group composes", async () => {
      const h = harness();
      const program = new Command();
      registerMemoryCommand(program, h.deps);

      await program.parseAsync(["node", "nax", "memory", "undo", COMPACT_ID, "--json"]);

      expect(h.codes).toEqual([0]);
      expect(h.out).toEqual([JSON.stringify(UNDONE)]);
      expect(h.undoCalls).toEqual([{ id: COMPACT_ID, force: false }]);
    });

    test("the flags a person types reach the same request", async () => {
      const h = harness();
      const program = new Command();
      registerMemoryCommand(program, h.deps);

      await program.parseAsync(["node", "nax", "memory", "undo", "--force"]);

      expect(h.codes).toEqual([0]);
      expect(h.out).toEqual([UNDONE_LINE]);
      expect(h.undoCalls).toEqual([{ force: true }]);
    });
  });
});
