/**
 * US-021 — `nax memory mirrors`: the global mirror inventory, and the one flag that removes from it.
 *
 * Every case drives `memoryMirrorsCommand` (or the program `registerMemoryCommand` builds) with the
 * inventory stubbed, so what is pinned is the surface: the row each mirror becomes, which suffix it
 * earns, which mirrors `--prune` will touch, the one question it asks, the one document a `--json`
 * consumer reads, and the exit code each way out becomes. The pruning rule itself is
 * `isPrunableMirror`'s (`test/unit/memory/mirrors.test.ts`); this file reads it through the command
 * rather than restating it.
 *
 * The deps this command takes are the group's own, not `MemoryCliDeps`: the inventory lives under
 * `~/.nax/memory/projects` and is the same whichever repository the terminal sits in, so the command
 * opens no config and no host. The last describe is the exception — it runs the real inventory over a
 * real directory, to prove a mirror the listing could not read all of survives `--prune --yes`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { Command } from "commander";
import {
  _memoryMirrorsCliDeps,
  type MemoryCliDeps,
  type MemoryMirrorsCliDeps,
  type MemoryMirrorsOptions,
  memoryMirrorsCommand,
  registerMemoryCommand,
} from "@/cli";
import { listMemoryMirrors, type MemoryMirrorInfo, memoryProjectsDir } from "@/memory";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The global projects directory every stubbed case lists. */
const PROJECTS_DIR = "/global/nax/memory/projects";

/** The repository the one mirror with a live origin belongs to. */
const ORIGIN_ROOT = "/src/api";

/** The repository a mirror records but no longer finds. */
const GONE_ROOT = "/src/gone";

/** The inventory the list-shaped cases read: one mirror with content, one leftover probe. */
const API_MIRROR: MemoryMirrorInfo = {
  dir: join(PROJECTS_DIR, "api-01234567"),
  name: "api-01234567",
  notes: 4,
  outbox: 2,
  provider: "koda:rs-stock",
  originRoot: ORIGIN_ROOT,
  rootExists: true,
  indexBytes: 512,
  inUse: false,
  hasArchive: true,
  decisions: 3,
  pendingForgets: 1,
  unreadable: [],
};

/** A mirror nothing has opened since the feature shipped: no origin, no sync, no content. */
const PROBE_MIRROR: MemoryMirrorInfo = {
  dir: join(PROJECTS_DIR, "probe-89abcdef"),
  name: "probe-89abcdef",
  notes: 0,
  outbox: 0,
  provider: null,
  originRoot: null,
  rootExists: null,
  indexBytes: 0,
  inUse: false,
  hasArchive: false,
  decisions: 0,
  pendingForgets: 0,
  unreadable: [],
};

/** Those two as the terminal prints them, one row each. */
const API_LINE = "api-01234567  notes 4  outbox 2  provider koda:rs-stock  index 512 bytes  origin /src/api";
const PROBE_LINE = "probe-89abcdef  notes 0  outbox 0  provider none  index 0 bytes  origin unknown";

/** An empty mirror whose own name is the only difference from {@link PROBE_MIRROR}. */
function emptyMirror(name: string): MemoryMirrorInfo {
  return { ...PROBE_MIRROR, dir: join(PROJECTS_DIR, name), name };
}

/** {@link PROBE_MIRROR} with the fields a case varies over. */
function probe(overrides: Partial<MemoryMirrorInfo>): MemoryMirrorInfo {
  return { ...PROBE_MIRROR, ...overrides };
}

// ─── harness ─────────────────────────────────────────────────────────────────

/** What one case varies. Absent means the harness default, never a different shape. */
interface Fixture {
  /** The inventory `listMemoryMirrors` answers; {@link PROBE_MIRROR} alone by default. */
  readonly mirrors?: readonly MemoryMirrorInfo[];
  /** Whether the terminal is interactive; `true` by default, so the question is reachable. */
  readonly isTTY?: boolean;
  /** What `deps.confirm` answers; `true` by default. */
  readonly confirmAnswer?: boolean;
  /**
   * What the inventory answers from its second read on — the mirror a writer changed between the
   * listing and the removal. Absent means the first inventory, read again.
   */
  readonly refilled?: readonly MemoryMirrorInfo[];
  /** Directories another writer holds, so `lockMirror` answers `null` for them. */
  readonly heldByOther?: readonly string[];
  /** Rejects the removal of this directory, as an unwritable filesystem would. */
  readonly removeRejects?: string;
}

/** Everything a case measures: both channels, every seam the run reached, and the order of them. */
interface Harness {
  readonly deps: MemoryMirrorsCliDeps;
  /** stdout lines. */
  readonly out: string[];
  /** stderr lines. */
  readonly err: string[];
  /** Every code handed to `exit`. */
  readonly codes: number[];
  /** Every directory handed to `removeDir`, in the order it was removed. */
  readonly removed: string[];
  /** Every question that reached `deps.confirm`. */
  readonly asks: string[];
  /** Every directory `listMemoryMirrors` was asked for. */
  readonly listed: string[];
  /** Every directory `lockMirror` was asked to lock, in the order it was asked. */
  readonly locked: string[];
  /** Every directory whose lock was handed back. */
  readonly released: string[];
  /** Every line written and every question asked, in the order it happened. */
  readonly events: string[];
}

/** The CLI with every external call stubbed: one inventory, one projects directory, no filesystem. */
function harness(fixture: Fixture = {}): Harness {
  const mirrors = fixture.mirrors ?? [PROBE_MIRROR];
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const removed: string[] = [];
  const asks: string[] = [];
  const listed: string[] = [];
  const locked: string[] = [];
  const released: string[] = [];
  const events: string[] = [];
  let reads = 0;
  const deps: MemoryMirrorsCliDeps = {
    log: (msg) => {
      out.push(msg);
      events.push(`out:${msg}`);
    },
    logErr: (msg) => {
      err.push(msg);
      events.push(`err:${msg}`);
    },
    exit: (code) => codes.push(code),
    isTTY: () => fixture.isTTY ?? true,
    confirm: async (question) => {
      asks.push(question);
      events.push(`ask:${question}`);
      return fixture.confirmAnswer ?? true;
    },
    projectsDir: () => PROJECTS_DIR,
    listMemoryMirrors: async (dir) => {
      listed.push(dir);
      reads += 1;
      return reads > 1 && fixture.refilled !== undefined ? fixture.refilled : mirrors;
    },
    lockMirror: async (dir) => {
      locked.push(dir);
      events.push(`lock:${dir}`);
      if (fixture.heldByOther?.includes(dir) === true) return null;
      return async () => {
        released.push(dir);
        events.push(`release:${dir}`);
      };
    },
    removeDir: async (dir) => {
      if (fixture.removeRejects === dir) throw new Error(`EACCES: ${dir}`);
      removed.push(dir);
      events.push(`removed:${dir}`);
    },
  };
  return { deps, out, err, codes, removed, asks, listed, locked, released, events };
}

/** `nax memory mirrors` with the given flags. */
function run(h: Harness, opts: Partial<MemoryMirrorsOptions> = {}): Promise<number> {
  return memoryMirrorsCommand({ ...opts }, h.deps);
}

/** The one document a `--json` run writes, parsed. */
function jsonDocument(h: Harness): readonly MemoryMirrorInfo[] {
  const [line] = h.out;
  assertDefined(line, "the --json document");
  return JSON.parse(line);
}

/** The group's own deps, which the mirrors command does not take: it only registers beside it. */
function groupDeps(): MemoryCliDeps {
  return {
    log: () => {},
    logErr: () => {},
    exit: () => {},
    findProjectDir: () => null,
    loadConfig: async () => makeNaxConfig({ name: "my-repo" }),
    createMemoryHost: async () => null,
    readFile: async () => "",
  };
}

// ─── the listing ─────────────────────────────────────────────────────────────

describe("nax memory mirrors — the listing", () => {
  test("AC-1: one row per mirror, in the inventory's order, and exit 0", async () => {
    const h = harness({ mirrors: [API_MIRROR, PROBE_MIRROR] });

    expect(await run(h)).toBe(0);
    expect(h.out).toEqual([API_LINE, PROBE_LINE]);
    expect(h.err).toEqual([]);
  });

  test("AC-1: it lists the global projects directory, not the caller's repository", async () => {
    const h = harness();

    await run(h);

    expect(h.listed).toEqual([PROJECTS_DIR]);
  });

  test("an inventory with no mirrors prints nothing and still exits 0", async () => {
    const h = harness({ mirrors: [] });

    expect(await run(h)).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.err).toEqual([]);
  });

  test("AC-2: a recorded root that is gone is marked (missing) after the root", async () => {
    const h = harness({ mirrors: [probe({ name: "gone-01234567", originRoot: GONE_ROOT, rootExists: false })] });

    await run(h);

    expect(h.out).toEqual([expect.stringContaining(`origin ${GONE_ROOT} (missing)`)]);
    expect(h.out[0]).toBe("gone-01234567  notes 0  outbox 0  provider none  index 0 bytes  origin /src/gone (missing)");
  });

  test("AC-2: a recorded root that still exists carries no mark", async () => {
    const h = harness({ mirrors: [probe({ originRoot: ORIGIN_ROOT, rootExists: true })] });

    await run(h);

    expect(h.out[0]).toBe("probe-89abcdef  notes 0  outbox 0  provider none  index 0 bytes  origin /src/api");
  });

  test("AC-3: a mirror whose sync.lock exists ends with (in use)", async () => {
    const h = harness({ mirrors: [probe({ inUse: true })] });

    await run(h);

    expect(h.out[0]).toBe("probe-89abcdef  notes 0  outbox 0  provider none  index 0 bytes  origin unknown (in use)");
  });

  test("AC-2 and AC-3: both marks appear, the missing root first", async () => {
    const h = harness({ mirrors: [probe({ originRoot: GONE_ROOT, rootExists: false, inUse: true })] });

    await run(h);

    expect(h.out[0]).toBe(
      "probe-89abcdef  notes 0  outbox 0  provider none  index 0 bytes  origin /src/gone (missing) (in use)",
    );
  });

  test("AC-4: a mirror with no origin prints origin unknown", async () => {
    const h = harness({ mirrors: [PROBE_MIRROR] });

    await run(h);

    expect(h.out[0]).toContain("origin unknown");
    expect(h.out[0]).not.toContain("(missing)");
  });
});

// ─── the machine-readable document ───────────────────────────────────────────

describe("nax memory mirrors --json", () => {
  test("AC-11: one JSON array of MemoryMirrorInfo objects, and nothing else on stdout", async () => {
    const h = harness({ mirrors: [API_MIRROR, PROBE_MIRROR] });

    expect(await run(h, { json: true })).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(jsonDocument(h)).toEqual([API_MIRROR, PROBE_MIRROR]);
  });

  test("AC-11: an empty inventory is still one array, not no output", async () => {
    const h = harness({ mirrors: [] });

    expect(await run(h, { json: true })).toBe(0);
    expect(h.out).toEqual(["[]"]);
  });
});

// ─── prune ───────────────────────────────────────────────────────────────────

describe("nax memory mirrors --prune", () => {
  /** Two leftover probes and the two mirrors that still hold something. */
  function mixedInventory(): MemoryMirrorInfo[] {
    return [
      API_MIRROR,
      emptyMirror("probe-01234567"),
      emptyMirror("probe-89abcdef"),
      probe({ name: "busy-01234567", inUse: true }),
    ];
  }

  test("AC-5: --yes removes every mirror isPrunableMirror accepts, once each", async () => {
    const h = harness({ mirrors: mixedInventory() });

    expect(await run(h, { prune: true, yes: true })).toBe(0);
    expect(h.removed).toEqual([join(PROJECTS_DIR, "probe-01234567"), join(PROJECTS_DIR, "probe-89abcdef")]);
  });

  test("AC-6: each removal prints Removed <name>", async () => {
    const h = harness({ mirrors: mixedInventory() });

    await run(h, { prune: true, yes: true });

    expect(h.out).toContain("Removed probe-01234567");
    expect(h.out).toContain("Removed probe-89abcdef");
  });

  test("AC-7: a mirror holding notes is never removed", async () => {
    const h = harness({ mirrors: mixedInventory() });

    await run(h, { prune: true, yes: true });

    expect(h.removed).not.toContain(API_MIRROR.dir);
  });

  test("AC-7: a mirror that is in use is never removed", async () => {
    const h = harness({ mirrors: mixedInventory() });

    await run(h, { prune: true, yes: true });

    expect(h.removed).not.toContain(join(PROJECTS_DIR, "busy-01234567"));
  });

  test("the prunable mirrors are listed before anything is removed", async () => {
    const h = harness({ mirrors: mixedInventory() });

    await run(h, { prune: true, yes: true });

    const firstRemoval = h.events.findIndex((event) => event.startsWith("removed:"));
    expect(h.events.slice(0, firstRemoval)).toEqual([
      "out:probe-01234567  notes 0  outbox 0  provider none  index 0 bytes  origin unknown",
      `out:${PROBE_LINE}`,
      "lock:/global/nax/memory/projects/probe-01234567",
    ]);
  });

  test("AC-8: on a TTY it asks Remove <K> mirrors? [y/N] and removes nothing when told no", async () => {
    const h = harness({ mirrors: mixedInventory(), confirmAnswer: false });

    expect(await run(h, { prune: true })).toBe(1);
    expect(h.asks).toEqual(["Remove 2 mirrors? [y/N]"]);
    expect(h.removed).toEqual([]);
    expect(h.err).toEqual(["Aborted"]);
  });

  test("AC-8: that question counts the mirrors actually prunable, not the inventory", async () => {
    const h = harness({ mirrors: [PROBE_MIRROR] });

    await run(h, { prune: true });

    expect(h.asks).toEqual(["Remove 1 mirrors? [y/N]"]);
  });

  test("a confirmed question removes them and exits 0", async () => {
    const h = harness({ mirrors: [PROBE_MIRROR], confirmAnswer: true });

    expect(await run(h, { prune: true })).toBe(0);
    expect(h.removed).toEqual([PROBE_MIRROR.dir]);
    expect(h.out).toContain("Removed probe-89abcdef");
  });

  test("AC-9: without a TTY and without --yes it aborts on stderr, exits 1 and removes nothing", async () => {
    const h = harness({ mirrors: mixedInventory(), isTTY: false });

    expect(await run(h, { prune: true })).toBe(1);
    expect(h.err).toEqual(["Aborted"]);
    expect(h.removed).toEqual([]);
    expect(h.asks).toEqual([]);
  });

  test("AC-10: with nothing prunable it says Nothing to prune and exits 0", async () => {
    const h = harness({ mirrors: [API_MIRROR] });

    expect(await run(h, { prune: true, yes: true })).toBe(0);
    expect(h.out).toEqual(["Nothing to prune"]);
    expect(h.removed).toEqual([]);
  });

  test("--yes asks no one", async () => {
    const h = harness({ mirrors: [PROBE_MIRROR] });

    await run(h, { prune: true, yes: true });

    expect(h.asks).toEqual([]);
  });
});

// ─── pruning under the mirror's own lock (F1) ────────────────────────────────
//
// The inventory is read before the question and the removal happens after it, so what a mirror
// held at listing time is not what it holds at removal time. Every removal is therefore taken
// under the lock the mirror's own writers take — `sync.lock`, through the shared protocol — and
// the mirror is read again once that lock is held. A mirror another writer owns, or one that
// gained something meanwhile, is skipped rather than deleted.

describe("nax memory mirrors --prune — the mirror lock", () => {
  /** Two leftover probes, one of which another writer holds. */
  const PROBE_A = join(PROJECTS_DIR, "probe-01234567");
  const PROBE_B = join(PROJECTS_DIR, "probe-89abcdef");

  test("F1: it takes the lock of every mirror it removes, before removing it", async () => {
    const h = harness({ mirrors: [emptyMirror("probe-01234567"), PROBE_MIRROR] });

    await run(h, { prune: true, yes: true });

    expect(h.locked).toEqual([PROBE_A, PROBE_B]);
    expect(h.events.indexOf(`lock:${PROBE_A}`)).toBeLessThan(h.events.indexOf(`removed:${PROBE_A}`));
    expect(h.events.indexOf(`lock:${PROBE_B}`)).toBeLessThan(h.events.indexOf(`removed:${PROBE_B}`));
  });

  test("F1: it hands every lock back, so the mirror is writable again", async () => {
    const h = harness({ mirrors: [emptyMirror("probe-01234567"), PROBE_MIRROR] });

    await run(h, { prune: true, yes: true });

    expect(h.released).toEqual([PROBE_A, PROBE_B]);
  });

  test("F1: a mirror another writer holds is left alone", async () => {
    const h = harness({ mirrors: [emptyMirror("probe-01234567"), PROBE_MIRROR], heldByOther: [PROBE_A] });

    expect(await run(h, { prune: true, yes: true })).toBe(0);
    expect(h.removed).toEqual([PROBE_B]);
    expect(h.err).toEqual(["Skipped probe-01234567: another writer holds it"]);
    expect(h.released).toEqual([PROBE_B]);
  });

  test("F1: a mirror that gained a note since the listing is not removed", async () => {
    const filled = { ...emptyMirror("probe-01234567"), notes: 1 };
    const h = harness({
      mirrors: [emptyMirror("probe-01234567"), PROBE_MIRROR],
      refilled: [filled, PROBE_MIRROR],
    });

    expect(await run(h, { prune: true, yes: true })).toBe(0);
    expect(h.removed).toEqual([PROBE_B]);
    expect(h.err).toEqual(["Skipped probe-01234567: it is no longer empty"]);
  });

  test("F1: the recheck happens under the lock, before the removal", async () => {
    const h = harness({ mirrors: [PROBE_MIRROR] });

    await run(h, { prune: true, yes: true });

    expect(h.events).toEqual([
      `out:${PROBE_LINE}`,
      `lock:${PROBE_B}`,
      `removed:${PROBE_B}`,
      `release:${PROBE_B}`,
      "out:Removed probe-89abcdef",
    ]);
    // The inventory is read again once the lock is held: the listing and the removal are two reads.
    expect(h.listed).toEqual([PROJECTS_DIR, PROJECTS_DIR]);
  });

  test("F1: the lock is handed back when the removal throws", async () => {
    const h = harness({ mirrors: [PROBE_MIRROR], removeRejects: PROBE_B });

    expect(await run(h, { prune: true, yes: true })).toBe(1);
    expect(h.err).toEqual([`Error: EACCES: ${PROBE_B}`]);
    expect(h.released).toEqual([PROBE_B]);
  });

  test("F1: a prune with nothing to remove takes no lock at all", async () => {
    const h = harness({ mirrors: [API_MIRROR] });

    await run(h, { prune: true, yes: true });

    expect(h.locked).toEqual([]);
  });

  test("F1: a plain listing takes no lock at all", async () => {
    const h = harness({ mirrors: [PROBE_MIRROR] });

    await run(h);

    expect(h.locked).toEqual([]);
  });
});

// ─── registration ────────────────────────────────────────────────────────────

describe("registerMemoryCommand — mirrors", () => {
  test("AC-12: mirrors is registered directly after undo, every earlier subcommand preserved", () => {
    const program = new Command();
    registerMemoryCommand(program, groupDeps());
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
    let saved: MemoryMirrorsCliDeps;

    beforeEach(() => {
      saved = { ..._memoryMirrorsCliDeps };
    });

    afterEach(() => {
      Object.assign(_memoryMirrorsCliDeps, saved);
    });

    test("AC-12: the mirrors action runs through the deps the command holds", async () => {
      const h = harness({ mirrors: [PROBE_MIRROR] });
      Object.assign(_memoryMirrorsCliDeps, {
        log: h.deps.log,
        logErr: h.deps.logErr,
        exit: h.deps.exit,
        projectsDir: h.deps.projectsDir,
        listMemoryMirrors: h.deps.listMemoryMirrors,
      });
      const program = new Command();
      registerMemoryCommand(program, groupDeps());

      await program.parseAsync(["node", "nax", "memory", "mirrors", "--json"]);

      expect(h.codes).toEqual([0]);
      expect(jsonDocument(h)).toEqual([PROBE_MIRROR]);
    });

    test("the real seams are the global projects directory, the real inventory and fs.rm", async () => {
      expect(_memoryMirrorsCliDeps.projectsDir()).toBe(memoryProjectsDir());
      expect(_memoryMirrorsCliDeps.listMemoryMirrors).toBe(listMemoryMirrors);
      expect(_memoryMirrorsCliDeps.isTTY()).toBe(process.stdin.isTTY === true);

      const dir = makeTempDir("nax-mirrors-rm-");
      await _memoryMirrorsCliDeps.removeDir(dir);
      expect(existsSync(dir)).toBe(false);
      cleanupTempDir(dir);
    });
  });
});

// ─── the mirror the listing could not read all of ────────────────────────────

describe("nax memory mirrors --prune --yes — a mirror with an unfollowable outbox entry", () => {
  let projectsDir: string;

  /** One mirror directory under the projects directory. */
  function mirrorDir(name: string): string {
    const dir = join(projectsDir, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    projectsDir = makeTempDir("nax-mirrors-cli-");
  });

  afterEach(() => {
    cleanupTempDir(projectsDir);
  });

  test("it is listed and never removed, while the empty mirror beside it goes", async () => {
    // A dangling link at an outbox entry name: the inventory can see the entry exists and cannot
    // count it, so the mirror is not one `--prune` may delete.
    const linked = mirrorDir("linked-01234567");
    mkdirSync(join(linked, "outbox"), { recursive: true });
    symlinkSync(join(linked, "absent-target"), join(linked, "outbox", "00000001-c_one.json"));
    const empty = mirrorDir("empty-89abcdef");
    const h = harness({ mirrors: [] });
    const deps: MemoryMirrorsCliDeps = {
      ...h.deps,
      // The real inventory over the real directory: the listing is what must refuse here.
      projectsDir: () => projectsDir,
      listMemoryMirrors,
    };

    expect(await memoryMirrorsCommand({ prune: true, yes: true }, deps)).toBe(0);

    expect(h.removed).toEqual([empty]);
    expect(h.out).toContain("Removed empty-89abcdef");
    expect(h.out).not.toContain("Removed linked-01234567");
  });

  test("a regular outbox entry beside it is still counted, and the mirror still survives", async () => {
    const dir = mirrorDir("half-01234567");
    mkdirSync(join(dir, "outbox"), { recursive: true });
    writeFileSync(join(dir, "outbox", "00000001-c_one.json"), "{}\n");
    symlinkSync(join(dir, "absent-target"), join(dir, "outbox", "00000002-c_two.json"));
    const h = harness({ mirrors: [] });
    const deps: MemoryMirrorsCliDeps = { ...h.deps, projectsDir: () => projectsDir, listMemoryMirrors };

    expect(await memoryMirrorsCommand({ prune: true, yes: true }, deps)).toBe(0);

    expect(h.out).toEqual(["Nothing to prune"]);
    expect(h.removed).toEqual([]);
  });
});
