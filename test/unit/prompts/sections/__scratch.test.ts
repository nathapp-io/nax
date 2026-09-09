import { describe, expect, test } from "bun:test";
import { applyProtocolRegions, unwrapProtocolRegions, wrapAffordance } from "@/prompts/sections";
import { NONCE } from "@/prompts/sections/protocol-region";

const ACP_BODY = "## Diff Access\n\nRun: `git diff`\n";

describe("scratch", () => {
  test("nested-brace invalid JSON region", () => {
    const spec = '{"ref":{"x":}}';
    const wrapped = `<!--nax:diff-access:${NONCE} ${spec}-->\n${ACP_BODY}<!--/nax:diff-access-->\n`;
    const out = applyProtocolRegions(wrapped, {
      protocol: "native",
      advertisedTools: new Set(["Git", "Read"]),
    });
    // If the review finding is correct, out !== ACP_BODY (markers survive).
    expect(out).toBe(ACP_BODY);
  });

  test("flat invalid JSON region", () => {
    const wrapped = wrapAffordance("diff-access", { ref: "abc123" }, ACP_BODY).replace(
      /\{"ref":"abc123"\}/,
      "{not json}",
    );
    const out = applyProtocolRegions(wrapped, {
      protocol: "native",
      advertisedTools: new Set(["Git", "Read"]),
    });
    expect(out).toBe(ACP_BODY);
  });

  test("unwrap returns", () => {
    const wrapped = wrapAffordance("diff-access", { ref: "abc123" }, ACP_BODY);
    const r = unwrapProtocolRegions(`prefix\n${wrapped}suffix\n`);
    // Verify the new contract: unwrap returns the full text, not an array.
    expect(typeof r).toBe("string");
  });
});
