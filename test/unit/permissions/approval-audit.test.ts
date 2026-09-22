import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { appendApprovalAudit } from "@/permissions";

let tempDir: string | undefined;

afterEach(() => {
  cleanupTempDir(tempDir);
  tempDir = undefined;
});

describe("approval audit", () => {
  test("appends one JSON object per line, with the command verbatim", async () => {
    tempDir = makeTempDir("approval-audit-");
    const row = {
      request: { tool: "Bash", stage: "implementer", rule: "Bash", summary: "s", command: "bun run test | tail -5" },
      decision: "allow" as const,
      decidedBy: "human" as const,
      latencyMs: 4210,
      at: "2026-09-22T10:00:00.000Z",
    };
    await appendApprovalAudit(tempDir, "run-1", row);
    await appendApprovalAudit(tempDir, "run-1", { ...row, decision: "deny", decidedBy: "timeout" });

    const lines = readFileSync(join(tempDir, "run-1.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).request.command).toBe("bun run test | tail -5");
    expect(JSON.parse(lines[1] as string).decidedBy).toBe("timeout");
  });
});
