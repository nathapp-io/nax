/**
 * S5 spec §8 Node lane: the packed package's `nax-agent` bin starts under Node,
 * prints its version, answers initialize and exits 0 when stdin closes.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(process.cwd(), "node_modules/.bin/nax-agent");
const configDir = mkdtempSync(join(tmpdir(), "acp-server-smoke-"));
const env = { ...process.env, NAX_AGENT_CONFIG_DIR: configDir };

try {
  const version = spawnSync(BIN, ["--version"], { env, encoding: "utf8" });
  if (version.status !== 0 || !/^\d+\.\d+\.\d+/.test(version.stdout)) {
    throw new Error(`--version failed: ${version.status} ${version.stdout} ${version.stderr}`);
  }
  const child = spawn(BIN, [], { env, stdio: ["pipe", "pipe", "inherit"] });
  const firstLine = new Promise((resolve) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\n");
      if (end !== -1) resolve(buffered.slice(0, end));
    });
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`,
  );
  const response = JSON.parse(await firstLine);
  if (response.result?.agentInfo?.name !== "nax-agent") throw new Error(`bad initialize: ${JSON.stringify(response)}`);
  child.stdin.end();
  const code = await exited;
  if (code !== 0) throw new Error(`server exited ${code}`);
  console.log("server smoke ok");
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
