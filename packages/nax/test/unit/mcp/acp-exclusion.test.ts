import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Glob } from "bun";

/**
 * Spec section 7: ACP is out of scope by CONSTRUCTION — coding tools never reach
 * the ACP adapter — so no guard exists to test. This records the property, so a
 * future change that hands codingTools to ACP fails here and forces the MCP
 * question to be answered deliberately.
 */
describe("ACP carries no coding-tool or MCP surface", () => {
  test("no file under src/agents/acp references codingTools or mcp", async () => {
    const root = resolve(import.meta.dir, "../../../src/agents/acp");
    const offenders: string[] = [];
    for await (const file of new Glob("**/*.ts").scan({ cwd: root, absolute: true })) {
      const text = await Bun.file(file).text();
      if (/codingTools|toolProviders|\bmcp\b/i.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
