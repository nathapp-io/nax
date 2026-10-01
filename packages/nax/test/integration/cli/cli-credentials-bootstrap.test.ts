import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("bin/nax.ts configures credentials before dispatch", () => {
  let globalDir: string;
  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "nax-cli-cred-"));
  });
  afterEach(() => rmSync(globalDir, { recursive: true, force: true }));

  test("nax auth list reads the credential store and exits successfully", async () => {
    const entrypoint = join(process.cwd(), "bin", "nax.ts");
    const proc = Bun.spawn(["bun", entrypoint, "auth", "list"], {
      cwd: globalDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(10_000),
      env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: globalDir },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const output = `${stdout}${stderr}`;
    expect(output).not.toContain("CREDENTIALS_NOT_CONFIGURED");
    expect(output).not.toContain("Credentials are not configured");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No credentials stored.");
  }, 60_000);
});
