/**
 * `nax memory requeue` and `nax memory discard` — what an operator does with undelivered writes.
 *
 * Every case enters through `program.parseAsync(["node", "nax", "memory", …])` with the
 * `MemoryCliDeps` seam stubbed, so what is pinned is the CLI as an operator invokes it: which
 * entries the host is asked to act on, the line it prints, and the code it exits with. The flag
 * checks — a slug, `--client <id>` or `--all`, exactly one — run before the host is opened.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { Command } from "commander";
import { type MemoryCliDeps, registerMemoryCommand } from "@/cli";
import type { MemoryHost, MemoryRecoveryResult, MemoryRecoveryTarget, MemoryRequeueOptions } from "@/memory";

/** One call the CLI made: which of the two operations, the entries it named and how. */
interface RejectedCall {
  readonly op: "requeue" | "discard";
  readonly target: MemoryRecoveryTarget;
  readonly options?: MemoryRequeueOptions;
}

/** The result a recovery answers with: what it moved, and what it held back. */
const MOVED_ONE: MemoryRecoveryResult = { moved: 1, heldBack: [] };

/** A host whose only read members are `requeue` and `discard`, each answering `result`. */
function fakeHost(result: MemoryRecoveryResult, targets: RejectedCall[]): MemoryHost {
  const unread = async (): Promise<never> => {
    throw new Error("this test reads only requeue and discard");
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
    forget: unread,
    approve: unread,
    requeue: async (target, options) => {
      targets.push({ op: "requeue", target, ...(options === undefined ? {} : { options }) });
      return result;
    },
    discard: async (target) => {
      targets.push({ op: "discard", target });
      return result;
    },
  };
}

interface Harness {
  readonly deps: MemoryCliDeps;
  readonly out: string[];
  readonly err: string[];
  readonly codes: number[];
  readonly targets: RejectedCall[];
  readonly opened: number[];
}

function harness(result: MemoryRecoveryResult = MOVED_ONE): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const targets: RejectedCall[] = [];
  const opened: number[] = [];
  const deps: MemoryCliDeps = {
    log: (msg) => out.push(msg),
    logErr: (msg) => err.push(msg),
    exit: (code) => codes.push(code),
    findProjectDir: () => null,
    loadConfig: async () => makeNaxConfig(),
    createMemoryHost: async () => {
      opened.push(1);
      return fakeHost(result, targets);
    },
    readFile: async () => "",
  };
  return { deps, out, err, codes, targets, opened };
}

async function runMemory(h: Harness, args: readonly string[]): Promise<void> {
  const program = new Command();
  registerMemoryCommand(program, h.deps);
  await program.parseAsync(["node", "nax", "memory", ...args]);
}

describe("nax memory requeue", () => {
  test("requeues one note's undelivered writes in the project scope and says to sync", async () => {
    const h = harness({ moved: 1, heldBack: [] });
    await runMemory(h, ["requeue", "gone"]);
    expect(h.targets).toEqual([
      { op: "requeue", target: { scope: "project", slug: "gone" }, options: { allowDuplicate: false } },
    ]);
    expect(h.out).toEqual(["requeued 1 undelivered write; run nax memory sync to deliver it"]);
    expect(h.codes).toEqual([0]);
  });

  test("--scope names the scope the note is in", async () => {
    const h = harness({ moved: 2, heldBack: [] });
    await runMemory(h, ["requeue", "tone", "--scope", "user"]);
    expect(h.targets[0]?.target).toEqual({ scope: "user", slug: "tone" });
    expect(h.out).toEqual(["requeued 2 undelivered writes; run nax memory sync to deliver them"]);
  });

  test("--all requeues every undelivered write", async () => {
    const h = harness({ moved: 3, heldBack: [] });
    await runMemory(h, ["requeue", "--all"]);
    expect(h.targets[0]?.target).toBe("all");
    expect(h.codes).toEqual([0]);
  });

  test("--client names one entry by the handle a lost-reply answer prints", async () => {
    const h = harness();
    await runMemory(h, ["requeue", "--client", "c_7"]);
    expect(h.targets).toEqual([{ op: "requeue", target: { clientId: "c_7" }, options: { allowDuplicate: false } }]);
  });

  test("--allow-duplicate reaches the host, which is what sends an uncertain write again", async () => {
    const h = harness();
    await runMemory(h, ["requeue", "--client", "c_7", "--allow-duplicate"]);
    expect(h.targets).toEqual([{ op: "requeue", target: { clientId: "c_7" }, options: { allowDuplicate: true } }]);
  });

  test("an entry the duplicate risk left in place is named with the flag that takes it", async () => {
    const h = harness({ moved: 0, heldBack: ["c_7"] });
    await runMemory(h, ["requeue", "--client", "c_7"]);
    expect(h.out.join("\n")).toContain("1 uncertain write(s) left in place (--client c_7)");
    expect(h.out.join("\n")).toContain("--allow-duplicate");
    expect(h.codes).toEqual([0]);
  });

  test("nothing to requeue is reported and still exits 0", async () => {
    const h = harness({ moved: 0, heldBack: [] });
    await runMemory(h, ["requeue", "--all"]);
    expect(h.out).toEqual(["no undelivered writes to requeue"]);
    expect(h.codes).toEqual([0]);
  });

  test("--json reports both what moved and what it held back", async () => {
    const h = harness({ moved: 2, heldBack: ["c_7"] });
    await runMemory(h, ["requeue", "--all", "--json"]);
    expect(h.out).toEqual([JSON.stringify({ requeued: 2, heldBack: ["c_7"] })]);
  });

  test("neither a slug, --client nor --all is a usage error, and the host is never opened", async () => {
    const h = harness();
    await runMemory(h, ["requeue"]);
    expect(h.codes).toEqual([1]);
    expect(h.opened).toEqual([]);
    expect(h.err.join("\n")).toContain("requeue needs a slug, --client <id> or --all");
  });

  test("a slug with --all is a usage error, and the host is never opened", async () => {
    const h = harness();
    await runMemory(h, ["requeue", "gone", "--all"]);
    expect(h.codes).toEqual([1]);
    expect(h.opened).toEqual([]);
  });

  test("--client with a slug is a usage error: they name different entries", async () => {
    const h = harness();
    await runMemory(h, ["requeue", "gone", "--client", "c_7"]);
    expect(h.codes).toEqual([1]);
    expect(h.opened).toEqual([]);
    expect(h.err.join("\n")).toContain("requeue takes one of a slug, --client <id> or --all");
  });

  test("--client with --scope is a usage error: a client id is already one entry", async () => {
    const h = harness();
    await runMemory(h, ["requeue", "--client", "c_7", "--scope", "user"]);
    expect(h.codes).toEqual([1]);
    expect(h.opened).toEqual([]);
  });
});

describe("nax memory requeue and discard flags", () => {
  test("--scope with --all is a usage error: --all already names every scope", async () => {
    const h = harness();
    await runMemory(h, ["requeue", "--all", "--scope", "user"]);
    expect(h.codes).toEqual([1]);
    expect(h.opened).toEqual([]);
    expect(h.err.join("\n")).toContain("--scope names one note's scope");
  });
});

describe("nax memory discard", () => {
  test("drops one note's undelivered writes and warns a discarded forget's note can come back", async () => {
    const h = harness({ moved: 1, heldBack: [] });
    await runMemory(h, ["discard", "gone"]);
    expect(h.targets).toEqual([{ op: "discard", target: { scope: "project", slug: "gone" } }]);
    expect(h.out).toEqual([
      "discarded 1 undelivered write; a discarded forget leaves its note on the provider, and the next sync brings it back",
    ]);
    expect(h.codes).toEqual([0]);
  });

  test("--client drops one uncertain entry, which is what unblocks that note", async () => {
    const h = harness();
    await runMemory(h, ["discard", "--client", "c_7"]);
    expect(h.targets).toEqual([{ op: "discard", target: { clientId: "c_7" } }]);
  });

  test("--all drops every undelivered write", async () => {
    const h = harness({ moved: 2, heldBack: [] });
    await runMemory(h, ["discard", "--all", "--json"]);
    expect(h.targets[0]?.target).toBe("all");
    expect(h.out).toEqual([JSON.stringify({ discarded: 2, heldBack: [] })]);
  });

  test("nothing to discard is reported and still exits 0", async () => {
    const h = harness({ moved: 0, heldBack: [] });
    await runMemory(h, ["discard", "--all"]);
    expect(h.out).toEqual(["no undelivered writes to discard"]);
  });

  test("[B5] names the source retirements the discard refused, and how to override it", async () => {
    const h = harness({ moved: 1, heldBack: [], refused: ["c_retire"] });
    await runMemory(h, ["discard", "--client", "c_7"]);
    const line = h.out.join("\n");
    expect(line).toContain("discarded 1 undelivered write");
    expect(line).toContain("1 write(s) that waited on it refused (--client c_retire)");
    expect(line).toContain("their sources stay on the provider; requeue one to send it anyway");
    expect(h.codes).toEqual([0]);
  });

  test("[B5] --json reports the refused writes beside what moved", async () => {
    const h = harness({ moved: 1, heldBack: [], refused: ["c_retire"] });
    await runMemory(h, ["discard", "--client", "c_7", "--json"]);
    expect(h.out).toEqual([JSON.stringify({ discarded: 1, heldBack: [], refused: ["c_retire"] })]);
  });

  test("a discard that refused nothing says nothing about refusals", async () => {
    const h = harness({ moved: 1, heldBack: [] });
    await runMemory(h, ["discard", "--client", "c_7", "--json"]);
    expect(h.out).toEqual([JSON.stringify({ discarded: 1, heldBack: [] })]);
  });

  test("neither a slug, --client nor --all is a usage error, and the host is never opened", async () => {
    const h = harness();
    await runMemory(h, ["discard"]);
    expect(h.codes).toEqual([1]);
    expect(h.opened).toEqual([]);
    expect(h.err.join("\n")).toContain("discard needs a slug, --client <id> or --all");
  });
});
