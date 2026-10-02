import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getAgentRuntime } from "@nathapp/nax-agent";
import { bunAgentRuntime } from "@/agent-runtime/bun-runtime";

describe("nax installs its Bun runtime", () => {
  test("every nax test runs nax-agent on the Bun runtime (installed by the preload)", () => {
    expect(getAgentRuntime()).toBe(bunAgentRuntime);
  });

  test("bin/nax.ts imports the install module before anything else", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../../bin/nax.ts")).text();
    const firstImport = source.split("\n").find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "../src/agent-runtime/install";');
  });
});
