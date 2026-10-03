import { expect, test } from "vitest";
import { runSmokeCommand } from "./process";

test("a subprocess deadline reports the command, cwd, timeout and captured output", () => {
  const script = 'console.log("progress"); console.error("warning"); setTimeout(() => {}, 1000);';
  let failure: unknown;
  try {
    runSmokeCommand(process.execPath, ["-e", script], process.cwd(), 250);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  for (const text of ["ETIMEDOUT", process.execPath, process.cwd(), "progress", "warning"]) {
    expect(String(failure)).toContain(text);
  }
});

test("a missing executable reports the spawn error", () => {
  expect(() => runSmokeCommand("/nax-smoke-missing-executable", [], process.cwd())).toThrow(/ENOENT/);
});

test("successful subprocess output is returned", () => {
  expect(runSmokeCommand(process.execPath, ["-e", 'console.log("ok")'], process.cwd())).toContain("ok");
});

test("compiler diagnostics can be returned for explicitly accepted exit codes", () => {
  const args = ["-e", 'console.error("error TS2307: missing declaration"); process.exit(2);'];
  expect(() => runSmokeCommand(process.execPath, args, process.cwd())).toThrow(/missing declaration/);
  expect(runSmokeCommand(process.execPath, args, process.cwd(), 30_000, [0, 2])).toContain("error TS2307");
});
