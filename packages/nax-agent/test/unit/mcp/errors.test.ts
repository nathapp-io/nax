import { describe, expect, test } from "bun:test";
import { NaxError } from "#src/infra/nax-error";
import { McpCallError, McpConnectError } from "#src/mcp/errors";

describe("mcp errors", () => {
  test("McpConnectError carries the connect code, stderr tail and context", () => {
    const error = new McpConnectError("boom", "stderr line", { server: "x" });
    expect(error).toBeInstanceOf(NaxError);
    expect(error.code).toBe("MCP_CONNECT_FAILED");
    expect(error.name).toBe("McpConnectError");
    expect(error.stderrTail).toBe("stderr line");
    expect(error.context).toEqual({ server: "x" });
  });

  test("McpConnectError defaults the stderr tail and context", () => {
    const error = new McpConnectError("boom");
    expect(error.stderrTail).toBeUndefined();
    expect(error.context).toEqual({});
  });

  test("McpCallError carries the call code and context", () => {
    const error = new McpCallError("bad", { tool: "echo" });
    expect(error).toBeInstanceOf(NaxError);
    expect(error.code).toBe("MCP_CALL_FAILED");
    expect(error.name).toBe("McpCallError");
    expect(error.context).toEqual({ tool: "echo" });
  });
});
