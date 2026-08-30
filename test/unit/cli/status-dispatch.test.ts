/**
 * dispatchStatusView — Status command view routing (US-002)
 *
 * AC-6: dispatchStatusView with { cost: true, json: true, last: true } invokes
 *       deps.emitCostReportJson and does NOT invoke deps.displayLastRunMetrics
 *       (JSON mode wins over --last).
 * AC-7: dispatchStatusView with { cost: true, json: true, model: true } invokes
 *       deps.emitCostReportJson and does NOT invoke deps.displayModelEfficiency
 *       (JSON mode wins over --model).
 * AC-8: dispatchStatusView with { cost: false, json: true } invokes
 *       deps.displayFeatureStatus with the feature-status options and does NOT
 *       invoke deps.emitCostReportJson.
 *
 * Plus commander-level wiring coverage so `status --json` is exercised end-to-end.
 */

import { describe, expect, mock, test } from "bun:test";
import { withTempDir } from "@test/helpers";
import { Command } from "commander";
import {
  _statusCommandActionDeps,
  _statusViewDeps,
  dispatchStatusView,
  registerStatusCommand,
  runStatusAction,
  type StatusCommandActionDeps,
  type StatusViewDeps,
} from "@/cli";

/** Every field typed as its Mock so `.mock.calls` reads without a cast. */
type MockedStatusViewDeps = { [K in keyof StatusViewDeps]: ReturnType<typeof mock> };

function makeDeps(): StatusViewDeps & MockedStatusViewDeps {
  return {
    displayCostMetrics: mock(async () => {}),
    displayLastRunMetrics: mock(async () => {}),
    displayModelEfficiency: mock(async () => {}),
    emitCostReportJson: mock(async () => {}),
    displayFeatureStatus: mock(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// AC-6: --cost --json --last → JSON mode wins
// ---------------------------------------------------------------------------

describe("dispatchStatusView — AC6: --cost --json --last", () => {
  test("AC6: with { cost: true, json: true, last: true }, invokes emitCostReportJson and does NOT invoke displayLastRunMetrics", async () => {
    const deps = makeDeps();
    const options = { cost: true, json: true, last: true };

    await dispatchStatusView("/tmp/workdir", options, deps);

    expect(deps.emitCostReportJson.mock.calls).toHaveLength(1);
    expect(deps.displayLastRunMetrics.mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-7: --cost --json --model → JSON mode wins
// ---------------------------------------------------------------------------

describe("dispatchStatusView — AC7: --cost --json --model", () => {
  test("AC7: with { cost: true, json: true, model: true }, invokes emitCostReportJson and does NOT invoke displayModelEfficiency", async () => {
    const deps = makeDeps();
    const options = { cost: true, json: true, model: true };

    await dispatchStatusView("/tmp/workdir", options, deps);

    expect(deps.emitCostReportJson.mock.calls).toHaveLength(1);
    expect(deps.displayModelEfficiency.mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-8: --json without --cost → feature status path
// ---------------------------------------------------------------------------

describe("dispatchStatusView — AC8: --json without --cost", () => {
  test("AC8: with { cost: false, json: true }, invokes displayFeatureStatus with the feature-status options and does NOT invoke emitCostReportJson", async () => {
    const deps = makeDeps();
    const options = { cost: false, json: true, feature: "feat-x", dir: "/tmp/workdir" };

    await dispatchStatusView("/tmp/workdir", options, deps);

    expect(deps.displayFeatureStatus.mock.calls).toHaveLength(1);
    expect(deps.emitCostReportJson.mock.calls).toHaveLength(0);
    const forwarded = deps.displayFeatureStatus.mock.calls[0]?.[0];
    expect(forwarded.feature).toBe("feat-x");
    expect(forwarded.dir).toBe("/tmp/workdir");
  });
});

// ---------------------------------------------------------------------------
// Commander-level wiring: status subcommand registers --json and routes
// to dispatchStatusView via runStatusAction (extracted from bin/nax.ts).
// ---------------------------------------------------------------------------

describe("registerStatusCommand — commander wiring for --json", () => {
  test("registers a subcommand named 'status' that exposes --json, --cost, --last, and --model", () => {
    const program = new Command();
    registerStatusCommand(program);

    const sub = program.commands.find((c) => c.name() === "status");
    expect(sub).toBeDefined();
    if (!sub) throw new Error("status subcommand not registered");
    const help = sub.helpInformation();
    expect(help).toContain("--json");
    expect(help).toContain("--cost");
    expect(help).toContain("--last");
    expect(help).toContain("--model");
  });
});

function makeActionDeps(
  viewDeps: StatusViewDeps = makeDeps(),
): StatusCommandActionDeps & { dispatchStatusView: ReturnType<typeof mock> } {
  return {
    validateDirectory: (dir: string) => dir,
    findProjectDir: () => "/tmp/.nax",
    dispatchStatusView: mock(async (_workdir: string, opts: Parameters<typeof dispatchStatusView>[1]) => {
      await dispatchStatusView(_workdir, opts, viewDeps);
    }),
  };
}

describe("runStatusAction — --cost --json --last routes through JSON mode", () => {
  test("with --cost --json --last, dispatches to emitCostReportJson and skips displayLastRunMetrics", async () => {
    const viewDeps = makeDeps();
    const actionDeps = makeActionDeps(viewDeps);

    await runStatusAction({ cost: true, json: true, last: true, dir: "/tmp/workdir" }, actionDeps);

    expect(viewDeps.emitCostReportJson.mock.calls).toHaveLength(1);
    expect(viewDeps.displayLastRunMetrics.mock.calls).toHaveLength(0);
  });
});

describe("runStatusAction — --json without --cost falls back to feature status", () => {
  test("with --json only, invokes displayFeatureStatus and does NOT invoke emitCostReportJson", async () => {
    const viewDeps = makeDeps();
    const actionDeps = makeActionDeps(viewDeps);

    await runStatusAction({ json: true, feature: "feat-x", dir: "/tmp/workdir" }, actionDeps);

    expect(viewDeps.displayFeatureStatus.mock.calls).toHaveLength(1);
    expect(viewDeps.emitCostReportJson.mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dispatchStatusView — non-JSON cost-mode branches (--cost, --cost --last,
// --cost --model) and the default feature-status fall-through.
// ---------------------------------------------------------------------------

describe("dispatchStatusView — non-JSON cost-mode routing", () => {
  test("--cost --last (no --json) invokes displayLastRunMetrics", async () => {
    const deps = makeDeps();
    await dispatchStatusView("/tmp/workdir", { cost: true, last: true }, deps);

    expect(deps.displayLastRunMetrics.mock.calls).toHaveLength(1);
    expect(deps.displayCostMetrics.mock.calls).toHaveLength(0);
  });

  test("--cost --model (no --json) invokes displayModelEfficiency", async () => {
    const deps = makeDeps();
    await dispatchStatusView("/tmp/workdir", { cost: true, model: true }, deps);

    expect(deps.displayModelEfficiency.mock.calls).toHaveLength(1);
    expect(deps.displayCostMetrics.mock.calls).toHaveLength(0);
  });

  test("--cost alone (no --last/--model/--json) invokes displayCostMetrics", async () => {
    const deps = makeDeps();
    await dispatchStatusView("/tmp/workdir", { cost: true }, deps);

    expect(deps.displayCostMetrics.mock.calls).toHaveLength(1);
  });

  test("no --cost and no --json falls through to displayFeatureStatus with empty options", async () => {
    const deps = makeDeps();
    await dispatchStatusView("/tmp/workdir", {}, deps);

    expect(deps.displayFeatureStatus.mock.calls).toHaveLength(1);
    const forwarded = deps.displayFeatureStatus.mock.calls[0]?.[0];
    expect(forwarded).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// runStatusAction — naxDir not found aborts with stderr + exit(1)
// ---------------------------------------------------------------------------

describe("runStatusAction — aborts when the project is not nax-initialized", () => {
  test("writes an error to stderr and calls process.exit(1) when findProjectDir returns null", async () => {
    const origExit = process.exit;
    const origWrite = process.stderr.write;
    let exitCode: number | undefined;
    const stderrChunks: string[] = [];
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__process_exit__");
    }) as typeof process.exit;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    const dispatch = mock(async (_workdir: string, _opts: Parameters<typeof dispatchStatusView>[1]) => {});
    const actionDeps: StatusCommandActionDeps = {
      validateDirectory: (dir: string) => dir,
      findProjectDir: () => null,
      dispatchStatusView: dispatch,
    };

    try {
      await expect(runStatusAction({ dir: "/tmp/not-a-nax-project" }, actionDeps)).rejects.toThrow("__process_exit__");
      expect(exitCode).toBe(1);
      expect(stderrChunks.some((c) => c.includes("nax not initialized"))).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      process.exit = origExit;
      process.stderr.write = origWrite;
    }
  });
});

// ---------------------------------------------------------------------------
// registerStatusCommand — action wiring (success + error handling)
// ---------------------------------------------------------------------------

describe("registerStatusCommand — action delegates to runStatusAction and handles errors", () => {
  test("invokes runStatusAction (via dispatchStatusView) on a successful parse", async () => {
    const deps = makeActionDeps();
    const program = new Command();
    program.exitOverride();
    registerStatusCommand(program, deps);

    await program.parseAsync(["status", "--dir", "/tmp/workdir"], { from: "user" });

    expect(deps.dispatchStatusView.mock.calls).toHaveLength(1);
  });

  test("writes an error to stderr and exits 1 when the action throws", async () => {
    const origExit = process.exit;
    const origWrite = process.stderr.write;
    let exitCode: number | undefined;
    const stderrChunks: string[] = [];
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__process_exit__");
    }) as typeof process.exit;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    const actionDeps: StatusCommandActionDeps = {
      validateDirectory: () => {
        throw new Error("bad directory");
      },
      findProjectDir: () => "/tmp/.nax",
      dispatchStatusView: mock(async (_workdir: string, _opts: Parameters<typeof dispatchStatusView>[1]) => {}),
    };
    const program = new Command();
    program.exitOverride();
    registerStatusCommand(program, actionDeps);

    try {
      await expect(program.parseAsync(["status"], { from: "user" })).rejects.toThrow("__process_exit__");
      expect(exitCode).toBe(1);
      expect(stderrChunks.some((c) => c.includes("bad directory"))).toBe(true);
    } finally {
      process.exit = origExit;
      process.stderr.write = origWrite;
    }
  });
});

// ---------------------------------------------------------------------------
// _statusViewDeps / _statusCommandActionDeps — real default implementations
// ---------------------------------------------------------------------------

describe("_statusViewDeps — real default implementations delegate to status-cost/status-features", () => {
  test("displayCostMetrics, displayLastRunMetrics, displayModelEfficiency and emitCostReportJson run against an empty workdir without throwing", async () => {
    await withTempDir(async (dir) => {
      await expect(_statusViewDeps.displayCostMetrics(dir)).resolves.toBeUndefined();
      await expect(_statusViewDeps.displayLastRunMetrics(dir)).resolves.toBeUndefined();
      await expect(_statusViewDeps.displayModelEfficiency(dir)).resolves.toBeUndefined();
      await expect(_statusViewDeps.emitCostReportJson(dir)).resolves.toBeUndefined();
    });
  });

  test("displayFeatureStatus runs against a nax-initialized workdir without throwing", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/.nax/config.json`, "{}");
      await expect(_statusViewDeps.displayFeatureStatus({ dir })).resolves.toBeUndefined();
    });
  });
});

describe("_statusCommandActionDeps — wires the real validateDirectory/findProjectDir/dispatchStatusView", () => {
  test("dispatchStatusView is the real dispatchStatusView function", () => {
    expect(_statusCommandActionDeps.dispatchStatusView).toBe(dispatchStatusView);
  });

  test("validateDirectory and findProjectDir are functions", () => {
    expect(typeof _statusCommandActionDeps.validateDirectory).toBe("function");
    expect(typeof _statusCommandActionDeps.findProjectDir).toBe("function");
  });
});
