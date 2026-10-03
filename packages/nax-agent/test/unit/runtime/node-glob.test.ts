import { describe, test } from "bun:test";
import { GLOB_CASES } from "@nathapp/nax-test-kit/cases/glob-cases";
import { nodeRuntime } from "#src/runtime/index";

describe("runtime glob behaviour", () => {
  for (const c of GLOB_CASES) test(c.name, () => c.run(nodeRuntime), 15_000);
});
