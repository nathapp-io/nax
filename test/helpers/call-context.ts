/**
 * Mock CallContext factory for unit tests.
 *
 * Provides a minimal valid CallContext without requiring a real runtime boot.
 * Tests that need dispatch/cost behaviour should use makeMockRuntime() instead.
 */
import type { CallContext } from "@/operations/types";
import { makeNaxConfig } from "./mock-nax-config";
import { makeTestRuntime } from "./runtime";

export function makeMockCallContext(overrides: Partial<CallContext> = {}): CallContext {
  const config = overrides.runtime
    ? undefined // don't construct a second runtime if caller provided one
    : makeNaxConfig();

  const runtime = overrides.runtime ?? makeTestRuntime({ config });

  // Build a minimal PackageView from the runtime's package registry.
  const packageView = overrides.packageView ?? runtime.packages.repo();

  return {
    runtime,
    packageView,
    packageDir: "/tmp/test",
    agentName: "claude",
    storyId: "US-001",
    ...overrides,
  };
}
