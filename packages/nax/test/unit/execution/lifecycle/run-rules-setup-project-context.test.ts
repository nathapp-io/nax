/**
 * US-007 — `configureRunRules` and the run's project-context override.
 *
 * The module already owns the run-start validation of `context.rules.overrideDir`
 * (US-002) and the rule-delivery handler set (US-005); the project-context file
 * joins them because this is the one place that runs after the config is resolved
 * but before any story starts. A file the operator asked for and that is missing
 * or oversized must stop the run, and a `mode: "replace"` run whose default agent
 * is not `native` must say out loud that the mode does not apply to that agent —
 * a warning, not a failure, because the run is still correct, only not
 * instructing the repository's own instruction file.
 *
 * The existence/size probe is a `_deps` seam here, so these tests never touch the
 * disk: `test/unit/context/project-context-override.test.ts` drives the real
 * loader and `test/integration/workflow-project-context.test.ts` drives the real
 * call site.
 *
 * The AC id is the test-name prefix where a case has one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
import { makeNaxConfig, makeSparseNaxConfig, withWarnSpy } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { _runRulesSetupDeps, configureRunRules } from "@/execution/lifecycle/run-rules-setup";

const REAL_LOAD = _runRulesSetupDeps.loadProjectContextOverride;
const REAL_DIR_EXISTS = _runRulesSetupDeps.dirExists;

afterEach(() => {
  _runRulesSetupDeps.loadProjectContextOverride = REAL_LOAD;
});

/** A distinguishable handler set — identity is an assertion in one test. */
const PLUGIN_HANDLERS: LoopHandlerSet = [{ plugin: "seed-note-plugin", event: "before_turn", handler: () => ({}) }];

/** Record the configs the loader seam was asked about. */
function stubLoader(load: (config: NaxConfig) => Promise<string | undefined>): NaxConfig[] {
  const asked: NaxConfig[] = [];
  _runRulesSetupDeps.loadProjectContextOverride = async (config) => {
    asked.push(config);
    return load(config);
  };
  return asked;
}

/** A run in workflow mode with the project-context keys the test cares about. */
function configWith(projectContext: { file?: string; mode?: "append" | "replace" }, agentDefault = "native") {
  return makeNaxConfig({ agent: { default: agentDefault }, context: { projectContext } });
}

function run(config: NaxConfig): Promise<LoopHandlerSet> {
  return configureRunRules({ config, workdir: "/repo", pluginHandlers: PLUGIN_HANDLERS });
}

describe("configureRunRules — the project-context file is validated (AC-5 seam, unit level)", () => {
  test("a configured file is loaded, with the run's own config", async () => {
    const asked = stubLoader(async () => "# Org context\n");
    const config = configWith({ file: "/abs/org-context.md" });

    const out = await run(config);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(config);
    expect(out[0]).toBe(PLUGIN_HANDLERS[0]);
  });

  test("a missing file rejects with its own error code, untouched", async () => {
    stubLoader(async () => {
      throw new NaxError("context.projectContext.file does not exist: /abs/gone.md", "PROJECT_CONTEXT_FILE_NOT_FOUND", {
        stage: "run-setup",
        file: "/abs/gone.md",
      });
    });

    const err = await run(configWith({ file: "/abs/gone.md" })).catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(NaxError);
    expect((err as NaxError).code).toBe("PROJECT_CONTEXT_FILE_NOT_FOUND");
  });

  test("a file past the cap rejects with PROJECT_CONTEXT_FILE_TOO_LARGE", async () => {
    stubLoader(async () => {
      throw new NaxError("context.projectContext.file is 32769 bytes", "PROJECT_CONTEXT_FILE_TOO_LARGE", {
        stage: "run-setup",
        file: "/abs/big.md",
      });
    });

    const err = await run(configWith({ file: "/abs/big.md" })).catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(NaxError);
    expect((err as NaxError).code).toBe("PROJECT_CONTEXT_FILE_TOO_LARGE");
  });

  test("a sparse config (no context block at all) still resolves, with no loader call", async () => {
    const asked = stubLoader(async () => undefined);

    await run(makeSparseNaxConfig({}));

    expect(asked).toHaveLength(0);
  });

  test("the project-context check does not disturb the rules-override check beside it", async () => {
    const asked = stubLoader(async () => "# Org context\n");
    const dirs: string[] = [];
    _runRulesSetupDeps.dirExists = async (path: string) => {
      dirs.push(path);
      return true;
    };

    try {
      await run(
        makeNaxConfig({
          context: { rules: { overrideDir: "/abs/org-rules" }, projectContext: { file: "/abs/org-context.md" } },
        }),
      );
    } finally {
      _runRulesSetupDeps.dirExists = REAL_DIR_EXISTS;
    }

    expect(dirs).toEqual(["/abs/org-rules"]);
    expect(asked).toHaveLength(1);
  });
});

describe("configureRunRules — the native-only replace warning (AC-15..AC-17 seam, unit level)", () => {
  test("replace mode with a configured file and a claude default warns once on run-setup", async () => {
    stubLoader(async () => "# Org context\n");

    await withWarnSpy(async (warnSpy) => {
      const out = await run(configWith({ file: "/abs/org-context.md", mode: "replace" }, "claude"));

      const runSetup = warnSpy.mock.calls.filter((call) => call[0] === "run-setup");
      expect(runSetup).toHaveLength(1);
      const message = runSetup[0]?.[1] ?? "";
      expect(message).toContain("replace");
      expect(message).toContain("native sessions only");
      expect(message).toContain("still load the repository's own instruction files");
      expect(runSetup[0]?.[2]).toMatchObject({ agent: "claude", file: "/abs/org-context.md" });
      // The warning continues the run: the plugin entries still lead the set.
      expect(out[0]).toBe(PLUGIN_HANDLERS[0]);
    });
  });

  test("a native default in replace mode is not warned about", async () => {
    stubLoader(async () => "# Org context\n");

    await withWarnSpy(async (warnSpy) => {
      await run(configWith({ file: "/abs/org-context.md", mode: "replace" }, "native"));

      expect(warnSpy.mock.calls.filter((call) => call[0] === "run-setup")).toEqual([]);
    });
  });

  test("append mode with a claude default is not warned about", async () => {
    stubLoader(async () => "# Org context\n");

    await withWarnSpy(async (warnSpy) => {
      await run(configWith({ file: "/abs/org-context.md", mode: "append" }, "claude"));

      expect(warnSpy.mock.calls.filter((call) => call[0] === "run-setup")).toEqual([]);
    });
  });

  test("replace mode with no configured file is not warned about — there is nothing to replace with", async () => {
    stubLoader(async () => undefined);

    await withWarnSpy(async (warnSpy) => {
      await run(configWith({ mode: "replace" }, "claude"));

      expect(warnSpy.mock.calls.filter((call) => call[0] === "run-setup")).toEqual([]);
    });
  });

  test("the default agent is resolved from config, not hardcoded: the schema default is native, so no warning", async () => {
    stubLoader(async () => "# Org context\n");
    // The operator sets no `agent.default`; the schema supplies `native`.
    const config = makeNaxConfig({ context: { projectContext: { file: "/abs/org-context.md", mode: "replace" } } });

    await withWarnSpy(async (warnSpy) => {
      expect(config.agent?.default).toBe("native");
      await run(config);

      expect(warnSpy.mock.calls.filter((call) => call[0] === "run-setup")).toEqual([]);
    });
  });
});
