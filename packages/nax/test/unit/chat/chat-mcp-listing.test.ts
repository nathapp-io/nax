import { describe, expect, test } from "bun:test";
import { type ChatMcpServerRow, type ChatMcpState, formatMcpListing } from "@/chat";
import type { McpServerEvent, McpWithheldEntry } from "@/mcp";
import type { ResourceDiagnostic } from "@/resources";

function row(overrides: Partial<ChatMcpServerRow> = {}): ChatMcpServerRow {
  return { id: "docs", source: "user", transport: "stdio", locked: true, ...overrides };
}

const connected = (serverId: string, toolCount: number): McpServerEvent => ({
  kind: "connected",
  serverId,
  workdir: "/w",
  at: "t",
  pid: 1,
  toolCount,
});
const failed = (serverId: string, reason: string): McpServerEvent => ({
  kind: "connect-failed",
  serverId,
  workdir: "/w",
  at: "t",
  reason,
  attempt: 1,
});
const withheldEntry = (serverId: string, name: string): McpWithheldEntry => ({
  serverId,
  name,
  reason: "absent-from-lock",
  lockSource: "project",
});

function state(
  options: {
    servers?: ChatMcpServerRow[];
    events?: McpServerEvent[];
    withheld?: McpWithheldEntry[];
    diagnostics?: ResourceDiagnostic[];
  } = {},
): ChatMcpState {
  return {
    servers: options.servers ?? [row()],
    diagnostics: options.diagnostics ?? [],
    events: () => options.events ?? [],
    withheld: () => options.withheld ?? [],
  };
}

function lineOf(text: string, id: string): string {
  const line = text.split("\n").find((entry) => entry.startsWith(`${id}  `));
  if (line === undefined) throw new Error(`no line for ${id} in:\n${text}`);
  return line;
}

describe("formatMcpListing", () => {
  test("AC-9 prints id, source, transport and connected tool count", () => {
    const text = formatMcpListing(state({ events: [connected("docs", 3)] }));
    expect(text).toContain("docs  user  stdio  connected, 3 tools");
  });
  test("AC-10 prints the failure reason after connect-failed", () => {
    const text = formatMcpListing(state({ events: [failed("docs", "spawn ENOENT")] }));
    expect(lineOf(text, "docs").endsWith("failed: spawn ENOENT")).toBe(true);
  });
  test("AC-11 a later connected event supersedes an earlier failure", () => {
    const text = formatMcpListing(state({ events: [failed("docs", "boom"), connected("docs", 2)] }));
    expect(lineOf(text, "docs").endsWith("connected, 2 tools")).toBe(true);
  });
  test("a later failure supersedes an earlier connection, and other servers' events are ignored", () => {
    const text = formatMcpListing(state({ events: [connected("docs", 2), failed("other", "x"), failed("docs", "y")] }));
    expect(lineOf(text, "docs").endsWith("failed: y")).toBe(true);
  });
  test("a closed event does not change the status", () => {
    const closed: McpServerEvent = { kind: "closed", serverId: "docs", workdir: "/w", at: "t" };
    const text = formatMcpListing(state({ events: [connected("docs", 2), closed] }));
    expect(lineOf(text, "docs").endsWith("connected, 2 tools")).toBe(true);
  });
  test("AC-12 a server with no event is not connected", () => {
    const text = formatMcpListing(state({ events: [connected("other", 1)] }));
    expect(lineOf(text, "docs").endsWith("not connected")).toBe(true);
  });
  test("AC-13 appends the withheld count for that server only", () => {
    const text = formatMcpListing(
      state({
        events: [connected("docs", 5)],
        withheld: [withheldEntry("docs", "a"), withheldEntry("docs", "b"), withheldEntry("other", "c")],
      }),
    );
    expect(lineOf(text, "docs").endsWith(", 2 withheld (run nax mcp lock)")).toBe(true);
  });
  test("AC-14 labels a plugin server with its plugin name", () => {
    const text = formatMcpListing(
      state({ servers: [row({ id: "chrome-server", source: "plugin", plugin: "chrome" })] }),
    );
    expect(lineOf(text, "chrome-server")).toContain("plugin chrome");
  });
  test("AC-15 labels a configured server config", () => {
    const text = formatMcpListing(state({ servers: [row({ source: "config" })] }));
    expect(lineOf(text, "docs")).toContain("  config  ");
  });
  test.each(["local", "project", "user"] as const)("labels a %s server with its scope", (source) => {
    const text = formatMcpListing(state({ servers: [row({ source })] }));
    expect(lineOf(text, "docs")).toBe(`docs  ${source}  stdio  not connected`);
  });
  test("prints http transport", () => {
    const text = formatMcpListing(state({ servers: [row({ transport: "http" })] }));
    expect(lineOf(text, "docs")).toBe("docs  user  http  not connected");
  });
  test("AC-16 prints a diagnostic as severity, path and message", () => {
    const diagnostics: ResourceDiagnostic[] = [
      { severity: "warn", path: "/r/.mcp.json", message: "m", origin: { kind: "claude-project" } },
    ];
    const lines = formatMcpListing(state({ diagnostics })).split("\n");
    expect(lines).toContain("warn  /r/.mcp.json  m");
    expect(lines.indexOf("warn  /r/.mcp.json  m")).toBeGreaterThan(lines.indexOf("docs  user  stdio  not connected"));
  });
  test("AC-17 undefined state has no servers", () => {
    expect(formatMcpListing(undefined)).toBe("(no MCP servers)");
  });
  test("AC-18 empty state has no servers", () => {
    expect(formatMcpListing(state({ servers: [] }))).toBe("(no MCP servers)");
  });
  test("with no servers, diagnostics still follow the placeholder", () => {
    const diagnostics: ResourceDiagnostic[] = [
      { severity: "error", path: "/r/.mcp.json", message: "bad", origin: { kind: "claude-project" } },
    ];
    expect(formatMcpListing(state({ servers: [], diagnostics }))).toBe("(no MCP servers)\nerror  /r/.mcp.json  bad");
  });
  test("AC-23 an unlocked row prints not locked as its status", () => {
    const text = formatMcpListing(
      state({ servers: [row({ id: "ctx", source: "project", locked: false })], events: [connected("ctx", 1)] }),
    );
    expect(lineOf(text, "ctx")).toBe("ctx  project  stdio  not locked (run nax mcp lock)");
  });
});
