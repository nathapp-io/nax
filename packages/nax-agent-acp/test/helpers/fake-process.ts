/** Running the fake ACP agent as a real subprocess, and reading what it recorded. */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { FakeRecord, FakeScript } from "#test/fixtures/fake-agent/script";

export const FAKE_MAIN = fileURLToPath(new URL("../fixtures/fake-agent/main.ts", import.meta.url));

/** The agent env for the fake: PATH, the script, and the record file when given. */
export function fakeEnv(script: FakeScript, recordPath?: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    FAKE_AGENT_SCRIPT: JSON.stringify(script),
    ...(recordPath === undefined ? {} : { FAKE_AGENT_RECORD: recordPath }),
  };
}

export function readRecords(path: string): FakeRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

const START = z.object({ pid: z.number(), cwd: z.string(), env: z.record(z.string(), z.boolean()) });
const CHILD = z.object({ pid: z.number() });

export function startOf(path: string): z.infer<typeof START> {
  return START.parse(readRecords(path).find((r) => r.method === "start")?.params);
}

export function childPidOf(path: string): number | undefined {
  const params = readRecords(path).find((r) => r.method === "child")?.params;
  return params === undefined ? undefined : CHILD.parse(params).pid;
}
