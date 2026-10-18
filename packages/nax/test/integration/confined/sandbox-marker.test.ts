import { expect, test } from "bun:test";
import { resolve } from "node:path";

const CHILD_TIMEOUT_MS = 10_000;

test("AC-5: a sandbox-marked child skips the unchanged session-tmp test", async () => {
  const env: Record<string, string | undefined> = { ...process.env, NAX_SANDBOXED: "1" };
  delete env.NAX_TEST_CONFINED;
  const child = Bun.spawn([process.execPath, "test", "test/unit/agents/coding-tool-support-session-tmp.test.ts"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: CHILD_TIMEOUT_MS,
  });
  try {
    const [exitCode, , stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/\b1 skip\b/);
  } finally {
    child.kill();
    await child.exited;
  }
}, CHILD_TIMEOUT_MS + 5_000);
