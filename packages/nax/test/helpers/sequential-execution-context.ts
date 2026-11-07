import type { SequentialExecutionContext } from "@/execution/executor-types";
import { createNoOpCostAggregator } from "@/runtime";
import { makeDispatchContext } from "./dispatch-context";
import { makeNaxConfig } from "./mock-nax-config";
import { makePluginRegistry } from "./plugin-registry";
import { makeStatusWriter } from "./status-writer";

/** No disk I/O; makeDispatchContext tracks and closes the runtime after each test. */
export function makeSequentialExecutionContext(
  overrides: Partial<SequentialExecutionContext> = {},
): SequentialExecutionContext {
  const config = overrides.config ?? makeNaxConfig({ execution: { iterationDelayMs: 0 } });
  return {
    ...makeDispatchContext({ config, costAggregator: createNoOpCostAggregator() }),
    prdPath: "/tmp/nax-budget-test/prd.json",
    workdir: "/tmp/nax-budget-test",
    config,
    hooks: { hooks: {} },
    feature: "budget-test",
    dryRun: false,
    useBatch: false,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    runId: "budget-run",
    startTime: 0,
    batchPlan: [],
    interactionChain: null,
    ...overrides,
  };
}
