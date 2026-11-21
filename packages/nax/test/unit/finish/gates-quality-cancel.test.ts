import { afterEach, describe, expect, test } from "bun:test";
import { _qualityGateDeps, type GateCommand, type GateRunRecord, runQualityGates } from "@/finish/gates/quality";
import type { QualityCommandOptions } from "@/quality";

const originalDeps = { ..._qualityGateDeps };
afterEach(() => {
  Object.assign(_qualityGateDeps, originalDeps);
});

const gates = (): GateCommand[] => ["lint", "test", "e2e"].map((name) => ({ name, command: name, cwd: "/repo" }));

/** Records every run call; `onCall` may abort mid-run. The stub always resolves with exit 0. */
function stubRun(onCall?: (o: QualityCommandOptions) => void): QualityCommandOptions[] {
  const calls: QualityCommandOptions[] = [];
  _qualityGateDeps.run = async (o) => {
    calls.push(o);
    onCall?.(o);
    const command = typeof o.command === "string" ? o.command : o.command.join(" ");
    return {
      commandName: o.commandName,
      command,
      success: true,
      exitCode: 0,
      output: "",
      durationMs: 1,
      timedOut: false,
    };
  };
  return calls;
}

async function rejectionCode(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error && "code" in err ? err.code : undefined;
  }
  return undefined;
}

describe("runQualityGates cancellation", () => {
  test("AC-1: an already-aborted signal rejects QUALITY_GATES_ABORTED and runs nothing", async () => {
    const calls = stubRun();
    const ac = new AbortController();
    ac.abort();
    expect(await rejectionCode(runQualityGates("/repo", gates(), { signal: ac.signal }))).toBe("QUALITY_GATES_ABORTED");
    expect(calls).toHaveLength(0);
  });

  test("AC-2/AC-3: abort during lint rejects, starts nothing further, and never calls onGate", async () => {
    const ac = new AbortController();
    const calls = stubRun(() => ac.abort());
    const records: GateRunRecord[] = [];
    const code = await rejectionCode(
      runQualityGates("/repo", gates(), { signal: ac.signal, onGate: (r) => records.push(r) }),
    );
    expect(code).toBe("QUALITY_GATES_ABORTED");
    expect(calls.map((c) => c.commandName)).toEqual(["lint"]);
    expect(records).toHaveLength(0);
  });

  test("AC-4: abort during e2e:setup rejects and the e2e command is not run", async () => {
    const ac = new AbortController();
    const calls = stubRun(() => ac.abort());
    const gate: GateCommand = { name: "e2e", command: "e2e", setup: "boot", cwd: "/repo" };
    expect(await rejectionCode(runQualityGates("/repo", [gate], { signal: ac.signal }))).toBe("QUALITY_GATES_ABORTED");
    expect(calls.map((c) => c.commandName)).toEqual(["e2e:setup"]);
  });

  test("AC-5: setup and command runs both receive the same signal object", async () => {
    const calls = stubRun();
    const ac = new AbortController();
    const gate: GateCommand = { name: "e2e", command: "e2e", setup: "boot", cwd: "/repo" };
    await runQualityGates("/repo", [gate], { signal: ac.signal });
    expect(calls.map((c) => c.commandName)).toEqual(["e2e:setup", "e2e"]);
    for (const c of calls) expect(c.signal).toBe(ac.signal);
  });

  test("AC-6: without a signal all gates run and no run options carry a signal key", async () => {
    const calls = stubRun();
    const res = await runQualityGates("/repo", gates(), {});
    expect(res.ran).toEqual(["lint", "test", "e2e"]);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect("signal" in c).toBe(false);
  });
});
