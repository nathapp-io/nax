/**
 * The `## MCP servers` section nax folds into a session's system field (#2517):
 * control characters are stripped, each server's text is capped, and the whole
 * section is capped so a chatty server cannot take the prompt.
 */
import { describe, expect, test } from "bun:test";
import {
  MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER,
  MCP_INSTRUCTIONS_MAX_CHARS_TOTAL,
  renderProviderInstructions,
} from "#src/tools/provider-instructions";

const entry = (providerId: string, text: string) => ({ providerId, text });

describe("renderProviderInstructions", () => {
  test("renders the section header, then one heading and text per server", () => {
    expect(renderProviderInstructions([entry("cm", "Call list_projects first")])).toBe(
      "## MCP servers\n\n### cm\nCall list_projects first",
    );
  });

  test("no servers renders no section at all", () => {
    expect(renderProviderInstructions([])).toBeUndefined();
  });

  test("strips control characters but keeps newlines and tabs", () => {
    expect(renderProviderInstructions([entry("cm", "a\u0007b\nc\td")])).toBe("## MCP servers\n\n### cm\nab\nc\td");
  });

  test("strips every C0 control except newline and tab, and DEL — carriage return included", () => {
    const controls = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code));
    const text = controls.filter((char) => char !== "\n" && char !== "\t").join("") + controls.join("") + "\u007F";
    // Only the tab and the newline of the second half survive, in that order.
    expect(renderProviderInstructions([entry("cm", text)])).toBe("## MCP servers\n\n### cm\n\t\n");
  });

  test("a CRLF body loses its carriage returns", () => {
    expect(renderProviderInstructions([entry("cm", "a\r\nb")])).toBe("## MCP servers\n\n### cm\na\nb");
  });

  test("caps one server's text and marks the cut", () => {
    const rendered = renderProviderInstructions([entry("cm", "x".repeat(2500))]);
    expect(rendered).toBe(`## MCP servers\n\n### cm\n${"x".repeat(2000)}…(truncated)`);
  });

  test("keeps the servers that fit the total and counts the rest", () => {
    const rendered = renderProviderInstructions([1, 2, 3, 4].map((n) => entry(`s${n}`, "x".repeat(1900)))) ?? "";
    expect(rendered).toContain("### s1");
    expect(rendered).toContain("### s2");
    expect(rendered).toContain("### s3");
    expect(rendered).not.toContain("### s4");
    expect(rendered.endsWith("(instructions omitted for 1 more MCP server(s))")).toBe(true);
  });

  test("the caps are the documented 2000 and 6000, and one server is never over the total", () => {
    expect(MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER).toBe(2000);
    expect(MCP_INSTRUCTIONS_MAX_CHARS_TOTAL).toBe(6000);
    expect(MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER).toBeLessThanOrEqual(MCP_INSTRUCTIONS_MAX_CHARS_TOTAL);
  });
});
