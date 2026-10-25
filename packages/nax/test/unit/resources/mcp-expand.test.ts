// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MCP `${VAR}` catalog syntax, not JS interpolation.
import { describe, expect, test } from "bun:test";
import { MCP_SERVER_ID_RE } from "@/config/schemas-mcp";
import { expandMcpValue, mcpServerId } from "@/resources";

describe("expandMcpValue", () => {
  test.each([
    { label: "AC-1", value: "${HOME}/bin", vars: { HOME: "/h" }, expected: { value: "/h/bin" } },
    { label: "AC-2", value: "${PORT:-8080}", vars: {}, expected: { value: "8080" } },
    { label: "AC-3", value: "${PORT:-8080}", vars: { PORT: "9" }, expected: { value: "9" } },
    { label: "AC-4", value: "${PORT:-8080}", vars: { PORT: "" }, expected: { value: "8080" } },
    { label: "AC-5", value: "${EMPTY}x", vars: { EMPTY: "" }, expected: { value: "x" } },
    { label: "AC-6", value: "$HOME and ${1X}", vars: {}, expected: { value: "$HOME and ${1X}" } },
    { label: "AC-7", value: "${A:-}x", vars: {}, expected: { value: "x" } },
    { label: "AC-8", value: "${MISSING}", vars: {}, expected: { missing: "MISSING" } },
    { label: "AC-9", value: "${A}-${B}", vars: { A: "1" }, expected: { missing: "B" } },
  ])("$label: expands $value", ({ value, vars, expected }) => {
    expect(expandMcpValue(value, vars)).toEqual(expected);
  });

  test.each([
    { label: "unterminated ${", value: "a${HOME", vars: { HOME: "/h" }, expected: "a${HOME" },
    { label: "unterminated default", value: "a${X:-def", vars: {}, expected: "a${X:-def" },
    { label: "trailing $", value: "cost$", vars: {}, expected: "cost$" },
    { label: "default stops at first }", value: "${X:-a}b}", vars: {}, expected: "ab}" },
    { label: "no nesting", value: "${X:-${Y}}", vars: { Y: "y" }, expected: "${Y}" },
    { label: "bad operator is literal", value: "${A-b}", vars: { A: "1" }, expected: "${A-b}" },
    { label: "undefined var uses default", value: "${A:-d}", vars: { A: undefined }, expected: "d" },
    { label: "plain text", value: "plain", vars: {}, expected: "plain" },
    { label: "set var ignores default", value: "${A:-${B}}", vars: { A: "1" }, expected: "1}" },
    { label: "inherited property is not a value", value: "${constructor:-d}", vars: {}, expected: "d" },
    { label: "repeated variables", value: "${A}${A}", vars: { A: "z" }, expected: "zz" },
  ])("copies literally or defaults: $label", ({ value, vars, expected }) => {
    expect(expandMcpValue(value, vars)).toEqual({ value: expected });
  });
});

describe("mcpServerId", () => {
  test.each([
    { label: "AC-10", input: "Codebase Memory.MCP", expected: "codebase-memory-mcp" },
    { label: "AC-11", input: "a__b", expected: "a_b" },
    { label: "AC-12", input: "--x", expected: "x" },
    { label: "AC-13", input: "!!!", expected: "" },
    { label: "empty input", input: "", expected: "" },
    { label: "underscore run", input: "a___b", expected: "a_b" },
    { label: "leading underscore stripped", input: "_x", expected: "x" },
    { label: "plugin-name base", input: "My Plugin-server", expected: "my-plugin-server" },
  ])("$label: normalizes $input", ({ input, expected }) => {
    expect(mcpServerId(input)).toBe(expected);
  });

  test.each(["Codebase Memory.MCP", "a__b", "--x", "chrome-devtools"])(
    "AC-14: id for %s matches MCP_SERVER_ID_RE and has no __",
    (input) => {
      const id = mcpServerId(input);
      expect(id).toMatch(MCP_SERVER_ID_RE);
      expect(id).not.toContain("__");
    },
  );
});
