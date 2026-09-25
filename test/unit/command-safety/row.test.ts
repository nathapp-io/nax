import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { appendCommandSafetyRow, type CommandSafetyRow } from "@/command-safety";

const row = (command: string): CommandSafetyRow => ({
  at: "2026-09-23T00:00:00.000Z",
  runId: "run-1",
  stage: "run",
  identity: "Bash",
  command,
  mechanical: { verdict: "allow", breach: false },
  outcome: { ledger: "ok" },
  rules: {
    version: 1,
    hits: {
      deletes_data: false,
      discards_work: false,
      outside_project: false,
      system_change: false,
      network_send: false,
      privilege: false,
    },
  },
  model: { status: "unavailable", questionSetVersion: 1, error: "network" },
});

describe("appendCommandSafetyRow", () => {
  test("hostile characters stay on ONE line and round-trip exactly (Review Focus 3)", async () => {
    await withTempDir(async (dir) => {
      const nasty = `echo "a\\"b" 'c'\n\ttail\u0000nul ünï ${"\\"}`;
      await appendCommandSafetyRow(join(dir, "command-safety"), "run-1", row(nasty));
      await appendCommandSafetyRow(join(dir, "command-safety"), "run-1", row("ls"));
      const lines = readFileSync(join(dir, "command-safety", "run-1.jsonl"), "utf8")
        .trimEnd()
        .split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? "").command).toBe(nasty);
      expect(JSON.parse(lines[1] ?? "").command).toBe("ls");
    });
  });

  test("review #9: the command is redacted, shell syntax after it kept", async () => {
    await withTempDir(async (dir) => {
      await appendCommandSafetyRow(join(dir, "command-safety"), "run-1", row("curl -H 'Cookie: a=b'; rm -rf ~"));
      const text = readFileSync(join(dir, "command-safety", "run-1.jsonl"), "utf8");
      expect(text).not.toContain("a=b");
      expect(text).toContain("rm -rf ~");
    });
  });
});
