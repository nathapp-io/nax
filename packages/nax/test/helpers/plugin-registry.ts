/**
 * A `PluginRegistry` the tests can assert against.
 *
 * Another class-not-interface case (see `makeLogger`, `makeStatusWriter`): the
 * empty-registry stub these tests need cannot satisfy the class, so nine sites
 * across four different owning types — `RunnerCompletionOptions`,
 * `SequentialExecutionContext`, `AcceptanceLoopContext`, and the bare class —
 * each cast their own (#1514 phase 1b).
 *
 * Defaults are an empty registry: every getter returns nothing, teardown is a
 * no-op. Override the getters a test actually exercises.
 */
import { mock } from "bun:test";
import { PluginRegistry } from "@/plugins/registry";

export type MockPluginRegistry = PluginRegistry & {
  getReporters: ReturnType<typeof mock>;
  getContextProviders: ReturnType<typeof mock>;
  getReviewers: ReturnType<typeof mock>;
  getRouters: ReturnType<typeof mock>;
  getOptimizers: ReturnType<typeof mock>;
  getPostRunActions: ReturnType<typeof mock>;
  getPostRunActionRegistrations: ReturnType<typeof mock>;
  getAgent: ReturnType<typeof mock>;
  getSource: ReturnType<typeof mock>;
  teardownAll: ReturnType<typeof mock>;
};

export function makePluginRegistry(overrides: Partial<Record<keyof PluginRegistry, unknown>> = {}): MockPluginRegistry {
  return Object.assign(
    new PluginRegistry([]),
    {
      getReporters: mock(() => []),
      getContextProviders: mock(() => []),
      getReviewers: mock(() => []),
      getRouters: mock(() => []),
      getOptimizers: mock(() => []),
      getPostRunActions: mock(() => []),
      getPostRunActionRegistrations: mock(() => []),
      getAgent: mock(() => undefined),
      getSource: mock(() => undefined),
      teardownAll: mock(async () => {}),
    },
    overrides,
  );
}
