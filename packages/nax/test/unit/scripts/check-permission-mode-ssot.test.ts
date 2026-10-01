import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPermissionModeViolations, formatPermissionModeViolationReport } from "@scripts/check-permission-mode-ssot";
import { makeTempDir } from "@test/helpers";

describe("findPermissionModeViolations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-permission-mode-check-");
    mkdirSync(join(tempDir, "src", "config"), { recursive: true });
    mkdirSync(join(tempDir, "src", "agents"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns empty array when the resolver is used", () => {
    writeFileSync(
      join(tempDir, "src", "safe.ts"),
      'import { resolvePermissions } from "@/config/permissions";\nconst { mode } = resolvePermissions(config, "run");\n',
    );

    expect(findPermissionModeViolations(tempDir)).toEqual([]);
  });

  test('flags an "approve-reads" literal passed as an argument', () => {
    writeFileSync(
      join(tempDir, "src", "agents", "close.ts"),
      'const session = await client.loadSession(handle, agentName, "approve-reads");\n',
    );

    const violations = findPermissionModeViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/agents/close.ts");
    expect(violations[0]?.line).toBe(1);
    expect(violations[0]?.mode).toBe("approve-reads");
  });

  test('flags an "approve-all" literal', () => {
    writeFileSync(join(tempDir, "src", "agents", "open.ts"), `const mode = 'approve-all';\n`);

    expect(findPermissionModeViolations(tempDir)).toHaveLength(1);
  });

  test("does not flag prose in comments", () => {
    writeFileSync(
      join(tempDir, "src", "commented.ts"),
      '// The unrestricted profile resolves to "approve-all".\nconst x = 1;\n',
    );

    expect(findPermissionModeViolations(tempDir)).toEqual([]);
  });

  test("does not flag prose in a trailing comment after real code", () => {
    writeFileSync(join(tempDir, "src", "trailing.ts"), 'const { mode } = resolve(); // "approve-reads" when safe\n');

    expect(findPermissionModeViolations(tempDir)).toEqual([]);
  });

  test("honours an explicit allow marker on a consumer comparison", () => {
    writeFileSync(
      join(tempDir, "src", "agents", "spawn.ts"),
      'const args = mode === "approve-all" ? ["--approve-all"] : []; // nax-permission-mode-allow: consumes a resolved mode\n',
    );

    expect(findPermissionModeViolations(tempDir)).toEqual([]);
  });

  test("exempts src/config/permissions.ts, the SSOT that owns the literals", () => {
    writeFileSync(join(tempDir, "src", "config", "permissions.ts"), 'return { mode: "approve-all" };\n');

    expect(findPermissionModeViolations(tempDir)).toEqual([]);
  });
});

describe("formatPermissionModeViolationReport", () => {
  test("returns ok message when there are no violations", () => {
    expect(formatPermissionModeViolationReport([])).toContain("[OK]");
  });

  test("includes file, line, and guidance when violations exist", () => {
    const report = formatPermissionModeViolationReport([
      {
        file: "src/agents/acp/adapter-close-physical.ts",
        line: 27,
        mode: "approve-reads",
        snippet: 'const session = await client.loadSession(handle, agentName, "approve-reads");',
      },
    ]);

    expect(report).toContain("[FAIL]");
    expect(report).toContain("src/agents/acp/adapter-close-physical.ts:27");
    expect(report).toContain("resolvePermissions(");
    expect(report).toContain("nax-permission-mode-allow");
  });
});
