import { DEFAULT_CONFIG } from "../../src/config";
import type { NaxConfig } from "../../src/config";
import { createRuntime, type CreateRuntimeOptions, type NaxRuntime } from "../../src/runtime";

export interface TestRuntimeOptions extends CreateRuntimeOptions {
  config?: NaxConfig;
  workdir?: string;
}

export function makeTestRuntime(opts?: TestRuntimeOptions): NaxRuntime {
  return createRuntime(opts?.config ?? DEFAULT_CONFIG, opts?.workdir ?? "/tmp/test", opts);
}
