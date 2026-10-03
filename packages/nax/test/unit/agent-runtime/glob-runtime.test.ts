import { describe, test } from "bun:test";
import { GLOB_CASES } from "@nathapp/nax-test-kit/cases/glob-cases";
import { bunAgentRuntime } from "@/agent-runtime/bun-runtime";

describe("runtime glob behaviour", () => {
  for (const c of GLOB_CASES) test(c.name, () => c.run(bunAgentRuntime), 15_000);
});
