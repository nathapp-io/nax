import { afterEach, describe, expect, test } from "bun:test";
import { _acceptanceDeps, parseAcceptanceGroups, runAcceptanceGate } from "@flows/nax-finish/steps/acceptance";

const originalRun = _acceptanceDeps.run;
afterEach(() => { _acceptanceDeps.run = originalRun; });

describe("acceptance steps", () => {
  test("parseAcceptanceGroups pulls the acceptance block", () => {
    const json = JSON.stringify({ acceptance: { status: "ok", groups: [{ packageDir: "apps/web", testPath: "apps/web/.nax/features/x/.nax-acceptance.test.tsx", exists: true, command: "bun vitest run {{FILE}}", language: "typescript" }] } });
    const r = parseAcceptanceGroups(json);
    expect(r.status).toBe("ok");
    expect(r.groups[0].packageDir).toBe("apps/web");
  });

  test("runAcceptanceGate runs each existing group at cwd=repoRoot/packageDir with absolute FILE", async () => {
    const calls: { cmd: string[]; cwd: string }[] = [];
    _acceptanceDeps.run = async (cmd, opts) => { calls.push({ cmd, cwd: opts.cwd }); return { exitCode: 0, stdout: "ok", stderr: "" }; };
    const groups = [{ packageDir: "apps/web", testPath: "apps/web/.nax/features/x/a.test.tsx", exists: true, command: "bun vitest run {{FILE}}", language: "typescript" }];
    const r = await runAcceptanceGate("/repo", groups);
    expect(r.passed).toBe(true);
    expect(calls[0].cwd).toBe("/repo/apps/web");
    expect(calls[0].cmd.join(" ")).toContain("/repo/apps/web/.nax/features/x/a.test.tsx"); // absolute FILE
  });

  test("runAcceptanceGate fails when a group exits non-zero", async () => {
    _acceptanceDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
    const groups = [{ packageDir: "", testPath: ".nax/features/x/a.test.ts", exists: true, command: "bun test {{FILE}}", language: "typescript" }];
    const r = await runAcceptanceGate("/repo", groups);
    expect(r.passed).toBe(false);
    expect(r.output).toContain("boom");
  });
});
