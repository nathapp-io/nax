import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { runMcpLockCommand } from "@/cli/mcp";
import { _mcpClientDeps } from "@/mcp/client";

const original = { ..._mcpClientDeps };
let projectDir: string;

beforeEach(() => {
  projectDir = realpathSync(makeTempDir("nax-cli-mcp-"));
  mkdirSync(join(projectDir, ".nax"), { recursive: true });
});

afterEach(() => {
  Object.assign(_mcpClientDeps, original);
  cleanupTempDir(projectDir);
});

function writeConfig(servers: Record<string, unknown>): void {
  writeFileSync(join(projectDir, ".nax", "config.json"), JSON.stringify({ name: "probe", mcp: { servers } }));
}

async function lockOutput(): Promise<string> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await runMcpLockCommand(projectDir);
    return log.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    log.mockRestore();
  }
}

describe("runMcpLockCommand empty-server hint", () => {
  test("AC-19: an HTTP server that advertises no tools is named by its url", async () => {
    Object.assign(_mcpClientDeps, {
      connect: async () => ({
        kind: "http",
        pid: null,
        tools: [],
        call: async () => ({ text: "", isError: false, bytesBeforeCap: 0 }),
        onClose: () => {},
        close: async () => {},
      }),
    });
    writeConfig({ docs: { url: "https://docs.example/mcp", stages: ["*"] } });

    const output = await lockOutput();

    expect(output).toContain("https://docs.example/mcp");
    expect(output).not.toContain("undefined");
  });
});
