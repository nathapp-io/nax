/**
 * US-015 — `nax memory compact`: the terminal's one confirmed compaction.
 *
 * Every case drives `memoryCompactCommand` (or the program `registerMemoryCommand` builds) with
 * `compactProjectMemory` stubbed, so no case reaches a model, and the host it is handed has no
 * readable member. What is pinned is the surface: which channel each line reaches, the order the
 * plan and the question arrive in, the exit code each outcome becomes, and the one document a
 * `--json` consumer reads.
 *
 * The stub answers the way the real orchestration does — it asks the `confirm` it was handed and
 * turns that answer into an applied or a declined outcome — so `--yes` and a refused confirmation
 * are measured through the surface that carries them rather than asserted against a fixture. The
 * threshold is 0.65, which is not the schema's default, so a `Still at` line proves it was read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, makeFakeMemoryHost, makeNaxConfig } from "@test/helpers";
import { Command } from "commander";
import {
  _confirmDeps,
  _memoryCompactCliDeps,
  type ConfirmChannel,
  type ConfirmStdin,
  type MemoryCliDeps,
  type MemoryCompactCliDeps,
  type MemoryCompactOptions,
  memoryCompactCommand,
  registerMemoryCommand,
} from "@/cli";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import {
  type CompactProjectMemoryInput,
  compactProjectMemory,
  type MemoryCompactOutcome,
  type MemoryCompactPreview,
  type MemoryHost,
} from "@/memory";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The directory `--dir` names in every stubbed case. */
const REPO_DIR = "/repo/my-repo";

/** The project key every message names: the config's `name`, never the directory's basename. */
const PROJECT = "my-repo";

/** The fill at or above which memory counts as nearly full — not the schema default. */
const THRESHOLD = 0.65;

/** The id the archive mints for one compaction. */
const COMPACT_ID = "20261125T101500Z-3fa2c1";

/** The question the command asks before it writes anything. */
const APPLY_QUESTION = "Apply? [y/N]";

/** The plan every case previews: two notes retired, and two groups of notes merged. */
const PREVIEW = {
  plan: {
    retire: [
      { slug: "checkout-page-story-notes", reason: "the checkout stories shipped" },
      { slug: "cache-layout-history", reason: "folded into the invariants note" },
    ],
    merge: [
      {
        from: ["cache-lru-internals", "cache-ttl-rules"],
        into: { slug: "cache-invariants", type: "project", description: "one note on the cache", body: "merged" },
      },
      {
        from: ["warmup-notes", "cold-start-notes", "prefetch-notes"],
        into: { slug: "cache-startup", type: "project", description: "one note on startup", body: "merged" },
      },
    ],
  },
  fillBefore: 0.9,
  notesBefore: 115,
  notesAfter: 72,
} satisfies MemoryCompactPreview;

/** The plan as the terminal prints it: the header, then one line per retire and per merge. */
const PLAN_LINES = [
  "Compaction plan for my-repo (90% full, 115 notes):",
  "  retire checkout-page-story-notes - the checkout stories shipped",
  "  retire cache-layout-history - folded into the invariants note",
  "  merge cache-lru-internals, cache-ttl-rules -> cache-invariants",
  "  merge warmup-notes, cold-start-notes, prefetch-notes -> cache-startup",
  "Notes: 115 -> 72",
];

/** What one apply did: three notes retired, five folded into two. */
const RESULT = {
  id: COMPACT_ID,
  retired: ["alpha", "beta", "gamma"],
  merged: [
    { from: ["delta", "epsilon", "zeta"], into: "delta-epsilon-zeta" },
    { from: ["eta", "theta"], into: "eta-theta" },
  ],
  notesBefore: 115,
  notesAfter: 72,
};

/** An applied outcome whose fill after the apply is `fillAfter`. */
function applied(fillAfter: number): MemoryCompactOutcome {
  return { kind: "applied", preview: PREVIEW, result: RESULT, fillAfter };
}

/** The outcome a person who answered no produces. */
const DECLINED = { kind: "declined", preview: PREVIEW } satisfies MemoryCompactOutcome;

/** A host the command only carries: every one of its members refuses to be read. */
const HOST: MemoryHost = makeFakeMemoryHost("nax memory compact hands its host to compactProjectMemory");

/** The config every case loads: named, and with a threshold the schema does not default to. */
function compactConfig(): NaxConfig {
  return makeNaxConfig({
    name: PROJECT,
    memory: { indexBytes: 1000, compact: { threshold: THRESHOLD, model: "balanced" } },
  });
}

// ─── harness ─────────────────────────────────────────────────────────────────

/** What one case varies. Absent means the harness default, never a different shape. */
interface Fixture {
  /** Whether the terminal the command runs on is interactive; `true` by default. */
  readonly isTTY?: boolean;
  /** What `deps.confirm` answers; `true` by default. */
  readonly confirmAnswer?: boolean;
  /** Asks the question through this seam instead of the recording stub (the real prompt). */
  readonly confirm?: MemoryCompactCliDeps["confirm"];
  /** Answers this outcome instead of the confirm-driven one. */
  readonly outcome?: MemoryCompactOutcome;
  /** Rejects the compaction with this error instead of answering an outcome. */
  readonly reject?: Error;
  /** Composes no host at all: `createMemoryHost` answers `null`, as a disabled mirror does. */
  readonly disabled?: boolean;
  readonly config?: NaxConfig;
}

/** Everything a case measures: the two output channels and every seam the run reached. */
interface Harness {
  readonly deps: MemoryCompactCliDeps;
  /** stdout lines. */
  readonly out: string[];
  /** stderr lines. */
  readonly err: string[];
  /** Every code handed to `exit`. */
  readonly codes: number[];
  /** What each `compactProjectMemory` call was given. */
  readonly compactCalls: CompactProjectMemoryInput[];
  /** Every question that reached `deps.confirm`. */
  readonly asks: string[];
  /** The channel each of those questions was asked on. */
  readonly channels: (ConfirmChannel | undefined)[];
  /** Every line written and every question asked, in the order it happened. */
  readonly events: string[];
}

/** The CLI with every external call stubbed: a repository with no `.nax` above `--dir`. */
function harness(fixture: Fixture = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const compactCalls: CompactProjectMemoryInput[] = [];
  const asks: string[] = [];
  const channels: (ConfirmChannel | undefined)[] = [];
  const events: string[] = [];
  const deps: MemoryCompactCliDeps = {
    log: (msg) => {
      out.push(msg);
      events.push(`out:${msg}`);
    },
    logErr: (msg) => {
      err.push(msg);
      events.push(`err:${msg}`);
    },
    exit: (code) => codes.push(code),
    findProjectDir: () => null,
    loadConfig: async () => fixture.config ?? compactConfig(),
    createMemoryHost: async () => (fixture.disabled === true ? null : HOST),
    readFile: async () => "",
    isTTY: () => fixture.isTTY ?? true,
    confirm:
      fixture.confirm ??
      (async (question, channel) => {
        asks.push(question);
        channels.push(channel);
        events.push(`ask:${question}`);
        return fixture.confirmAnswer ?? true;
      }),
    compactProjectMemory: async (input) => {
      compactCalls.push(input);
      events.push("compact");
      if (fixture.reject !== undefined) throw fixture.reject;
      if (fixture.outcome !== undefined) return fixture.outcome;
      if (input.dryRun) return { kind: "dry-run", preview: PREVIEW };
      const answer = await input.confirm(PREVIEW);
      events.push(`answered:${answer}`);
      return answer ? applied(0.414) : DECLINED;
    },
  };
  return { deps, out, err, codes, compactCalls, asks, channels, events };
}

/** The group's own deps, without the three compacting seams the group composes itself. */
function groupDeps(h: Harness): MemoryCliDeps {
  return {
    log: h.deps.log,
    logErr: h.deps.logErr,
    exit: h.deps.exit,
    findProjectDir: h.deps.findProjectDir,
    loadConfig: h.deps.loadConfig,
    createMemoryHost: h.deps.createMemoryHost,
    readFile: h.deps.readFile,
  };
}

/** `nax memory compact` with the given flags. */
function run(h: Harness, opts: Partial<MemoryCompactOptions> = {}): Promise<number> {
  return memoryCompactCommand({ dir: REPO_DIR, ...opts }, h.deps);
}

/** The one document a `--json` run writes, parsed. */
function jsonDocument(h: Harness): Record<string, unknown> {
  const [line] = h.out;
  assertDefined(line, "the --json document");
  return JSON.parse(line);
}

/**
 * A TTY stdin that answers the first prompt with `key` as soon as it is listened to.
 *
 * The prompt is driven for real in the one case that measures which channel its own text goes
 * to; every other case stubs the seam. Nothing else about the terminal matters here, so the
 * bookkeeping `confirm.test.ts` records is left out.
 */
function answeringStdin(key: string): ConfirmStdin {
  return {
    isTTY: true,
    setRawMode: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    setEncoding: () => undefined,
    on: (_event, listener) => {
      queueMicrotask(() => listener(key));
    },
    once: () => undefined,
    removeListener: () => undefined,
  };
}

// ─── the confirmation gate ───────────────────────────────────────────────────

describe("nax memory compact — the confirmation gate", () => {
  test("AC-1: without --yes and without a TTY it aborts on stderr and exits 1", async () => {
    const h = harness({ isTTY: false });

    expect(await run(h)).toBe(1);
    expect(h.err).toEqual(["Aborted"]);
    expect(h.out).toEqual([]);
  });

  test("AC-2: that abort reaches no compaction", async () => {
    const h = harness({ isTTY: false });

    await run(h);

    expect(h.compactCalls).toEqual([]);
    expect(h.events).not.toContain("compact");
  });

  test("a refused confirmation aborts: AC-6", async () => {
    const h = harness({ confirmAnswer: false });

    expect(await run(h)).toBe(1);
    expect(h.err).toEqual(["Aborted"]);
  });
});

// ─── the plan ────────────────────────────────────────────────────────────────

describe("nax memory compact — the plan", () => {
  test("AC-3: the header names the project, the fill and the note count before the plan lines", async () => {
    const h = harness();

    await run(h);

    expect(h.out[0]).toBe(PLAN_LINES[0]);
    expect(h.out.slice(0, PLAN_LINES.length)).toEqual(PLAN_LINES);
  });

  test("AC-4: one retire line per retire and one merge line per merge", async () => {
    const h = harness();

    await run(h);

    expect(h.out.filter((line) => line.startsWith("  "))).toEqual([
      "  retire checkout-page-story-notes - the checkout stories shipped",
      "  retire cache-layout-history - folded into the invariants note",
      "  merge cache-lru-internals, cache-ttl-rules -> cache-invariants",
      "  merge warmup-notes, cold-start-notes, prefetch-notes -> cache-startup",
    ]);
  });

  test("AC-5: the plan ends with the note count and the question follows it", async () => {
    const h = harness();

    await run(h);

    expect(h.out.slice(0, PLAN_LINES.length)).toEqual(PLAN_LINES);
    expect(h.asks).toEqual([APPLY_QUESTION]);
    expect(h.channels).toEqual(["stdout"]);
    expect(h.events.indexOf(`ask:${APPLY_QUESTION}`)).toBeGreaterThan(h.events.indexOf("out:Notes: 115 -> 72"));
    expect(h.events.indexOf(`ask:${APPLY_QUESTION}`)).toBeLessThan(h.events.indexOf("answered:true"));
  });

  test("--yes asks no one and hands compaction a confirm that answers true: AC-7", async () => {
    const h = harness();

    expect(await run(h, { yes: true })).toBe(0);
    expect(h.asks).toEqual([]);
    expect(h.events).toContain("answered:true");
  });
});

// ─── the applied outcome ─────────────────────────────────────────────────────

describe("nax memory compact — the applied outcome", () => {
  test("AC-8: it reports what the apply did and where the undo lives", async () => {
    const h = harness();

    expect(await run(h, { yes: true })).toBe(0);
    expect(h.out.at(-1)).toBe(
      "Compacted memory: retired 3, merged 5 into 2 (90% -> 41%). Undo: nax memory undo 20261125T101500Z-3fa2c1",
    );
  });

  test.each([THRESHOLD, 0.7249])(
    "AC-9: a fill after of %p still at or above the threshold says so",
    async (fillAfter) => {
      const h = harness({ outcome: applied(fillAfter) });

      expect(await run(h, { yes: true })).toBe(0);
      expect(h.out).toContain(
        `Still at ${Math.round(fillAfter * 100)}%: the remaining entries are not compaction candidates`,
      );
    },
  );

  test("AC-10: no Still at line when the fill after is below the threshold", async () => {
    const h = harness({ outcome: applied(0.414) });

    await run(h, { yes: true });

    expect(h.out.some((line) => line.startsWith("Still at"))).toBe(false);
  });
});

// ─── the dry run ─────────────────────────────────────────────────────────────

describe("nax memory compact --dry-run", () => {
  test("AC-11: without a TTY it asks compaction for a dry run, previews the plan and exits 0", async () => {
    const h = harness({ isTTY: false });

    expect(await run(h, { dryRun: true })).toBe(0);
    expect(h.compactCalls.map((call) => call.dryRun)).toEqual([true]);
    expect(h.out).toEqual(PLAN_LINES);
    expect(h.err).toEqual([]);
  });

  test("AC-12: it never calls deps.confirm", async () => {
    const h = harness();

    await run(h, { dryRun: true });

    expect(h.asks).toEqual([]);
  });
});

// ─── the outcomes that leave memory alone ────────────────────────────────────

describe("nax memory compact — the outcomes", () => {
  test("AC-13: nothing to compact says how full memory is and exits 0", async () => {
    const h = harness({ outcome: { kind: "nothing-to-compact", fill: 0.122 } });

    expect(await run(h, { yes: true })).toBe(0);
    expect(h.out).toEqual(["Nothing to compact (12% full)"]);
    expect(h.err).toEqual([]);
  });

  test("AC-14: an unusable reply is an error on stderr and exit 1", async () => {
    const h = harness({ outcome: { kind: "unparseable" } });

    expect(await run(h, { yes: true })).toBe(1);
    expect(h.err).toEqual(["Error: the compaction model returned no usable plan; nothing was changed"]);
    expect(h.out).toEqual([]);
  });

  test("AC-15: a rejected plan is an error with one reason line each", async () => {
    const reasons = [
      "retire names a note that is not a candidate: alpha",
      "merge cache-invariants takes the slug of an existing note",
    ];
    const h = harness({ outcome: { kind: "invalid", reasons } });

    expect(await run(h, { yes: true })).toBe(1);
    expect(h.err).toEqual([
      "Error: the compaction plan was rejected; nothing was changed",
      `  - ${reasons[0]}`,
      `  - ${reasons[1]}`,
    ]);
    expect(h.out).toEqual([]);
  });

  test("AC-16: proposal write mode is unsupported, named on stderr", async () => {
    const h = harness({ outcome: { kind: "unsupported" } });

    expect(await run(h, { yes: true })).toBe(1);
    expect(h.err).toEqual([
      'Error: memory compaction is not available with memory.writeMode "proposal"; nothing was changed',
    ]);
    expect(h.out).toEqual([]);
  });

  test("AC-17: a mirror busy with a sync is Error: <message> and exit 1", async () => {
    const h = harness({
      reject: new NaxError("memory is busy: a sync is running", "MEMORY_BUSY", { stage: "memory" }),
    });

    expect(await run(h, { yes: true })).toBe(1);
    expect(h.err).toEqual(["Error: memory is busy: a sync is running"]);
    expect(h.out).toEqual([]);
  });

  test("a disabled mirror is Error: <message> and exit 1", async () => {
    const h = harness({ disabled: true });

    expect(await run(h, { yes: true })).toBe(1);
    expect(h.err).toEqual(["Error: memory is disabled (memory.enabled is false)"]);
    expect(h.compactCalls).toEqual([]);
  });
});

// ─── the machine-readable document ───────────────────────────────────────────

describe("nax memory compact --json", () => {
  test.each([
    { outcome: applied(0.414), kind: "applied" },
    { outcome: { kind: "nothing-to-compact", fill: 0.12 }, kind: "nothing-to-compact" },
    { outcome: { kind: "invalid", reasons: ["a reason"] }, kind: "invalid" },
  ] satisfies readonly { outcome: MemoryCompactOutcome; kind: string }[])(
    "AC-18: one document on stdout whose outcome is $kind",
    async ({ outcome, kind }) => {
      const h = harness({ outcome });

      await run(h, { yes: true, json: true });

      expect(h.out).toHaveLength(1);
      expect(jsonDocument(h).outcome).toBe(kind);
    },
  );

  test("AC-18: the document carries the outcome's own fields", async () => {
    const h = harness({ outcome: applied(0.414) });

    await run(h, { yes: true, json: true });

    const document = jsonDocument(h);
    expect(document.fillAfter).toBe(0.414);
    expect((document.result as { id: string }).id).toBe(COMPACT_ID);
  });

  test("AC-19: on a TTY the plan goes to stderr and the question is asked there", async () => {
    const h = harness();

    await run(h, { json: true });

    expect(h.out).toHaveLength(1);
    expect(jsonDocument(h).outcome).toBe("applied");
    expect(h.err).toEqual(PLAN_LINES);
    expect(h.asks).toEqual([APPLY_QUESTION]);
    expect(h.channels).toEqual(["stderr"]);
  });

  describe("the real prompt (F1)", () => {
    let saved: Pick<typeof _confirmDeps, "stdin" | "write" | "writeErr">;

    beforeEach(() => {
      saved = { stdin: _confirmDeps.stdin, write: _confirmDeps.write, writeErr: _confirmDeps.writeErr };
    });

    afterEach(() => {
      Object.assign(_confirmDeps, saved);
    });

    test("AC-19: the question lands on stderr, so stdout holds the document alone", async () => {
      const stdoutWrites: string[] = [];
      const stderrWrites: string[] = [];
      Object.assign(_confirmDeps, {
        stdin: answeringStdin("y"),
        write: (text: string) => {
          stdoutWrites.push(text);
          return true;
        },
        writeErr: (text: string) => {
          stderrWrites.push(text);
          return true;
        },
      });
      const h = harness({ confirm: _memoryCompactCliDeps.confirm });

      expect(await run(h, { json: true })).toBe(0);

      // The prompt's own text — question and newline — never reaches the stdout writer.
      expect(stdoutWrites).toEqual([]);
      expect(stderrWrites.join("")).toContain(APPLY_QUESTION);
      expect(h.out).toHaveLength(1);
      expect(jsonDocument(h).outcome).toBe("applied");
    });
  });
});

// ─── registration ────────────────────────────────────────────────────────────

describe("registerMemoryCommand — compact", () => {
  test("AC-20: compact is registered after the existing subcommands", () => {
    const program = new Command();
    registerMemoryCommand(program, groupDeps(harness()));
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
    ]);
  });

  describe("through the group's own deps", () => {
    let saved: Omit<MemoryCompactCliDeps, keyof MemoryCliDeps>;

    beforeEach(() => {
      saved = { ..._memoryCompactCliDeps };
    });

    afterEach(() => {
      Object.assign(_memoryCompactCliDeps, saved);
    });

    test("AC-20: the compact action runs through the deps the group composes", async () => {
      const h = harness();
      Object.assign(_memoryCompactCliDeps, {
        isTTY: h.deps.isTTY,
        confirm: h.deps.confirm,
        compactProjectMemory: h.deps.compactProjectMemory,
      });
      const program = new Command();
      registerMemoryCommand(program, groupDeps(h));

      await program.parseAsync(["node", "nax", "memory", "compact", "--yes", "--json"]);

      expect(h.codes).toEqual([0]);
      expect(jsonDocument(h).outcome).toBe("applied");
    });
  });

  test("the real seam is the process's own terminal and the real orchestration", () => {
    expect(_memoryCompactCliDeps.isTTY()).toBe(process.stdin.isTTY === true);
    expect(_memoryCompactCliDeps.compactProjectMemory).toBe(compactProjectMemory);
  });
});
