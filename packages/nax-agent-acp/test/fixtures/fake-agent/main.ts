/**
 * Subprocess entry of the fake ACP agent. FAKE_AGENT_SCRIPT holds the JSON
 * FakeScript. FAKE_AGENT_RECORD, when set, names a file every received request
 * is appended to as one JSON line, after a "start" record with the pid, cwd and
 * which of `recordEnv` are set. Runs under Bun (unit suite) and Node 22+
 * (contract suite, type stripping), so it uses erasable TypeScript only and
 * writes stderr synchronously (pipes are asynchronous on macOS).
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { buildFakeAgent } from "./agent.ts";
import type { FakeScript } from "./script.ts";

const script: FakeScript = JSON.parse(process.env.FAKE_AGENT_SCRIPT ?? "{}");
const recordPath = process.env.FAKE_AGENT_RECORD;

function record(method: string, params: unknown): void {
  if (recordPath !== undefined) appendFileSync(recordPath, `${JSON.stringify({ method, params })}\n`);
}

function exit(code: number, stderr?: string): never {
  if (stderr !== undefined) writeSync(2, stderr);
  process.exit(code);
}

const startup = script.startup ?? {};
if (startup.ignoreSigterm === true) process.on("SIGTERM", () => {});
record("start", {
  pid: process.pid,
  cwd: process.cwd(),
  env: Object.fromEntries((script.recordEnv ?? []).map((key) => [key, process.env[key] !== undefined])),
});
if (startup.spawnChild === true) record("child", { pid: spawn("sleep", ["30"], { stdio: "ignore" }).pid });
if (startup.stderr !== undefined) writeSync(2, startup.stderr);
if (startup.exitCode !== undefined) exit(startup.exitCode);
if (startup.hang === true) {
  setInterval(() => {}, 60_000);
} else {
  if (startup.garbageLine === true) writeSync(1, "this line is not JSON\n");
  if (startup.oversizedLineBytes !== undefined) writeSync(1, `${"x".repeat(startup.oversizedLineBytes)}\n`);
  buildFakeAgent(script, { record, exit }).connect(
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
}
