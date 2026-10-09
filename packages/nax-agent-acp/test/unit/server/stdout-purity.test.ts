/**
 * S5 spec §8: stdout of the real server process carries JSON-RPC frames only.
 * Spawns the bin's code path under bun with an empty config dir.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";

const ENTRY = fileURLToPath(new URL("../../fixtures/server/run.ts", import.meta.url));
const PKG = fileURLToPath(new URL("../../..", import.meta.url));

function frame(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

describe("the server process", () => {
  test("writes only JSON-RPC frames to stdout and exits 0 when stdin closes", async () => {
    const configDir = makeTempDir("acp-server-purity-");
    try {
      const child = spawn("bun", [ENTRY], {
        cwd: PKG,
        env: { ...process.env, NAX_AGENT_CONFIG_DIR: configDir, NAX_AGENT_LOG: "debug" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.resume();
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.stdin.write(frame(1, "initialize", { protocolVersion: 1 }));
      child.stdin.write(frame(2, "session/new", { cwd: configDir, mcpServers: [] }));
      child.stdin.write(frame(3, "no/such_method", {}));
      child.stdin.write(frame(4, "session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "x" }] }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      child.stdin.end();
      expect(await exited).toBe(0);
      const lines = Buffer.concat(out)
        .toString("utf8")
        .split("\n")
        .filter((l) => l !== "");
      const frames = lines.map((l) => JSON.parse(l));
      expect(frames.every((f) => f.jsonrpc === "2.0")).toBe(true);
      expect(frames.find((f) => f.id === 1)?.result?.agentInfo?.name).toBe("nax-agent");
      // No model configured in the empty config dir (S5-2): invalid_params.
      expect(frames.find((f) => f.id === 2)?.error?.code).toBe(-32602);
      expect(frames.find((f) => f.id === 3)?.error?.code).toBe(-32601);
      expect(frames.find((f) => f.id === 4)?.error?.code).toBe(-32002);
    } finally {
      cleanupTempDir(configDir);
    }
  }, 30_000);
});
