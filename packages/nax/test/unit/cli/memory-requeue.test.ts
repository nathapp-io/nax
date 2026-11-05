/**
 * `nax memory requeue` — put rejected outbox entries back in the queue.
 *
 * Every case enters through `program.parseAsync(["node", "nax", "memory", …])` with the
 * `MemoryCliDeps` seam stubbed, so what is pinned is the CLI as an operator invokes it: which
 * entries the host is asked to requeue, the line it prints, and the code it exits with. The
 * flag checks — a slug or `--all`, never both — run before the host is opened.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { Command } from "commander";
import { type MemoryCliDeps, registerMemoryCommand } from "@/cli";
import type { MemoryHost, MemoryRequeueTarget } from "@/memory";

/** A host whose only read member is `requeue`, answering `count` and recording each target. */
function fakeHost(count: number, targets: MemoryRequeueTarget[]): MemoryHost {
  const unread = async (): Promise<never> => {
    throw new Error("this test reads only requeue");
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
    requeue: async (target) => {
      targets.push(target);
      return count;
    },
  };
}

interface Harness {
  readonly deps: MemoryCliDeps;
  readonly out: string[];
  readonly err: string[];
  readonly codes: number[];
  readonly targets: MemoryRequeueTarget[];
  readonly opened: number[];
}

function harness(count = 1): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const targets: MemoryRequeueTarget[] = [];
  const opened: number[] = [];
  const deps: MemoryCliDeps = {
    log: (msg) => out.push(msg),
    logErr: (msg) => err.push(msg),
    exit: (code) => codes.push(code),
    findProjectDir: () => null,
    loadConfig: async () => makeNaxConfig(),
    createMemoryHost: async () => {
      opened.push(1);
      return fakeHost(count, targets);
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
  test("requeues one note's rejected writes in the project scope and says to sync", async () => {
    const h = harness(1);
    await runMemory(h, ["requeue", "gone"]);
    expect(h.targets).toEqual([{ scope: "project", slug: "gone" }]);
    expect(h.out).toEqual(["requeued 1 rejected write; run nax memory sync to deliver it"]);
    expect(h.codes).toEqual([0]);
  });

  test("--scope names the scope the note is in", async () => {
    const h = harness(2);
    await runMemory(h, ["requeue", "tone", "--scope", "user"]);
    expect(h.targets).toEqual([{ scope: "user", slug: "tone" }]);
    expect(h.out).toEqual(["requeued 2 rejected writes; run nax memory sync to deliver them"]);
  });

  test("--all requeues every rejected write", async () => {
    const h = harness(3);
    await runMemory(h, ["requeue", "--all"]);
    expect(h.targets).toEqual(["all"]);
    expect(h.codes).toEqual([0]);
  });

  test("nothing to requeue is reported and still exits 0", async () => {
    const h = harness(0);
    await runMemory(h, ["requeue", "--all"]);
    expect(h.out).toEqual(["no rejected writes to requeue"]);
    expect(h.codes).toEqual([0]);
  });

  test("neither a slug nor --all is a usage error, and the host is never opened", async () => {
    const h = harness();
    await runMemory(h, ["requeue"]);
    expect(h.codes).toEqual([1]);
    expect(h.opened).toEqual([]);
    expect(h.err.join("\n")).toContain("requeue needs a slug or --all");
  });

  test("a slug with --all is a usage error, and the host is never opened", async () => {
    const h = harness();
    await runMemory(h, ["requeue", "gone", "--all"]);
    expect(h.codes).toEqual([1]);
    expect(h.opened).toEqual([]);
  });
});
