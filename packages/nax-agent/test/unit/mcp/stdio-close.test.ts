import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { isProcessAlive } from "#src/internal/process-alive";
import { waitForStdioExit } from "#src/mcp/stdio-close";

/** Kills a pid that may already be gone; used in finally blocks so a failing test never leaks a child. */
function killQuietly(pid: number): void {
  if (pid <= 0) return; // never signal a process group / an unknown pid
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** A child that ignores SIGTERM, resolved only once its handler is installed; kills and rejects if it never is. */
function stubbornChild(timeoutMs = 5000): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready')"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killQuietly(child.pid ?? -1);
      reject(new Error("stubborn child never became ready"));
    }, timeoutMs);
    child.stdout?.once("data", () => {
      clearTimeout(timer);
      resolve(child);
    });
  });
}

describe("waitForStdioExit", () => {
  test("resolves at once when exited() is already true", async () => {
    const started = Date.now();
    await waitForStdioExit(999_999, () => true, 5000);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("SIGKILLs a child that ignores SIGTERM within graceMs", async () => {
    const child = await stubbornChild();
    const pid = child.pid ?? -1;
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    try {
      child.kill("SIGTERM"); // ignored: the handler is installed
      const started = Date.now();
      await waitForStdioExit(pid, () => exited, 300);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      killQuietly(pid);
    }
  });

  test("returns without killing when the pid is already gone", async () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    const pid = child.pid ?? -1;
    try {
      await new Promise((resolve) => child.on("exit", resolve));
      await waitForStdioExit(pid, () => false, 300);
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      killQuietly(pid);
    }
  });
});
