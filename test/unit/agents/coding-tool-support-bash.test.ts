import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";

let root: string;

beforeEach(() => {
  root = makeTempDir("bash-wiring-");
});

afterEach(() => {
  cleanupTempDir(root);
});

const support = (args: Parameters<typeof buildCodingToolSupport>[0]) => buildCodingToolSupport({ root, ...args });

describe("Bash wiring", () => {
  test("declared and granted: advertised", () => {
    const built = support({
      declared: ["Read", "Bash"],
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Bash", patterns: ["bun test *"] },
      ],
    });
    expect(built?.tools.map((tool) => tool.name)).toContain("Bash");
  });

  test("granted but NOT declared: never reachable (spec §6 row 11, the op ceiling)", async () => {
    const built = support({
      declared: ["Read"],
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Bash", patterns: ["bun test *"] },
      ],
    });
    expect(built?.tools.map((tool) => tool.name)).not.toContain("Bash");
    const outcome = await built?.runtime.callTool("Bash", { command: "bun test" });
    expect(outcome?.kind).toBe("denied");
    if (outcome?.kind === "denied") expect(outcome.reason).toContain("unknown tool");
  });

  test("declared but NOT granted: not advertised, and denied BY THE POLICY (spec §6 rows 1-2)", async () => {
    const built = support({ declared: ["Read", "Bash"], grants: [{ tool: "Read", patterns: ["*"] }] });
    expect(built?.tools.map((tool) => tool.name)).not.toContain("Bash");
    const outcome = await built?.runtime.callTool("Bash", { command: "bun test" });
    expect(outcome?.kind).toBe("denied");
    // NOT "unknown tool": the tool exists, the grant does not. That is what
    // lets the denial carry a redirect (row 1), and it is the whole reason
    // creation is gated on declaration rather than on the grant.
    if (outcome?.kind === "denied") expect(outcome.reason).not.toContain("unknown tool");
  });

  test("the project's shell reaches the tool", () => {
    const built = support({
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["*"] }],
      shell: "/bin/zsh",
    });
    expect(built?.tools.find((tool) => tool.name === "Bash")?.description).toContain("/bin/zsh");
  });
});
