import { describe, test } from "bun:test";
import { SPAWN_CASES } from "@nathapp/nax-test-kit/cases/spawn-cases";
import { bunAgentRuntime } from "@/agent-runtime/bun-runtime";

describe("nax's Bun runtime meets the spawn behaviour cases", () => {
  for (const c of SPAWN_CASES) test(c.name, () => c.run(bunAgentRuntime), 15_000);
});
