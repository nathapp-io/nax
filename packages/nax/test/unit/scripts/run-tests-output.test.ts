import { describe, expect, test } from "bun:test";
import type { TestOutputController } from "@scripts/run-tests-output";
import { createTestOutputController } from "@scripts/run-tests-output";
import { parseTestOutput } from "@/test-runners";

function stream(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

function makeTarget(): { chunks: string[]; write: (chunk: string) => boolean } {
  const chunks: string[] = [];
  return { chunks, write: (chunk) => chunks.push(chunk) > 0 };
}

describe("createTestOutputController", () => {
  test("captures child output in agent mode and discards it on success", async () => {
    const stdout = makeTarget();
    const stderr = makeTarget();
    const controller = createTestOutputController({ agentMode: true, stdout, stderr });

    expect(controller.stdio).toEqual(["inherit", "pipe", "pipe"]);
    const output = await controller.collect(stream("expected stdout"), stream("expected stderr"));
    controller.finish(output, false);

    expect(stdout.chunks).toEqual([]);
    expect(stderr.chunks).toEqual([]);
  });

  test("replays captured stdout and stderr when an agent-mode phase fails", async () => {
    const stdout = makeTarget();
    const stderr = makeTarget();
    const controller = createTestOutputController({ agentMode: true, stdout, stderr });

    const output = await controller.collect(stream("failure stdout"), stream("failure stderr"));
    controller.finish(output, true);

    expect(stdout.chunks).toEqual(["failure stdout"]);
    expect(stderr.chunks).toEqual(["failure stderr"]);
  });

  test("inherits output in verbose mode without attempting to replay it", async () => {
    const stdout = makeTarget();
    const stderr = makeTarget();
    const controller = createTestOutputController({ agentMode: false, stdout, stderr });

    expect(controller.stdio).toEqual(["inherit", "inherit", "inherit"]);
    const output = await controller.collect(undefined, undefined);
    controller.finish(output, true);

    expect(output).toEqual({ stdout: "", stderr: "" });
    expect(stdout.chunks).toEqual([]);
    expect(stderr.chunks).toEqual([]);
  });
});

/** A `bun test` summary tail, as bun prints it on its own stream. */
function bunSummary(passed: number, failed: number): string {
  return `  ${passed} pass\n  ${failed} fail\n`;
}

function makeController(agentMode: boolean): {
  controller: TestOutputController;
  stdout: { chunks: string[]; write: (chunk: string) => boolean };
  stderr: { chunks: string[]; write: (chunk: string) => boolean };
  finishPhase: (output: { stdout: string; stderr: string }, abnormal?: boolean) => Promise<void>;
} {
  const stdout = makeTarget();
  const stderr = makeTarget();
  const controller = createTestOutputController({ agentMode, stdout, stderr });
  const finishPhase = async (output: { stdout: string; stderr: string }, abnormal = false) => {
    controller.finish(await controller.collect(stream(output.stdout), stream(output.stderr)), abnormal);
  };
  return { controller, stdout, stderr, finishPhase };
}

describe("createTestOutputController summaryLines", () => {
  test("totals bun pass/fail summary lines across passing agent-mode phases", async () => {
    const { controller, finishPhase } = makeController(true);

    await finishPhase({ stdout: "", stderr: bunSummary(10, 0) });
    await finishPhase({ stdout: "", stderr: bunSummary(5, 0) });

    expect(controller.summaryLines()).toBe(" 15 pass\n 0 fail\n");
  });

  test("emits a total that parseTestOutput reads as 15 passed and 0 failed", async () => {
    const { controller, finishPhase } = makeController(true);

    await finishPhase({ stdout: "", stderr: bunSummary(10, 0) });
    await finishPhase({ stdout: "", stderr: bunSummary(5, 0) });
    const summary = parseTestOutput(controller.summaryLines());

    expect(summary.passed).toBe(15);
    expect(summary.failed).toBe(0);
  });

  test("returns an empty string when no phase printed a bun summary line", async () => {
    const { controller, finishPhase } = makeController(true);

    await finishPhase({ stdout: "no summary here", stderr: "some log noise\n" });

    expect(controller.summaryLines()).toBe("");
  });

  test("returns an empty string and replays full output for an abnormal phase", async () => {
    const { controller, stdout, stderr, finishPhase } = makeController(true);

    await finishPhase({ stdout: "captured stdout", stderr: `captured stderr\n${bunSummary(3, 1)}` }, true);

    expect(controller.summaryLines()).toBe("");
    expect(stdout.chunks).toEqual(["captured stdout"]);
    expect(stderr.chunks).toEqual([`captured stderr\n${bunSummary(3, 1)}`]);
  });

  test("returns an empty string in verbose mode", async () => {
    const { controller, finishPhase } = makeController(false);

    await finishPhase({ stdout: "", stderr: bunSummary(9, 0) });

    expect(controller.summaryLines()).toBe("");
  });

  test("reads a summary printed on stdout when stderr is empty", async () => {
    const { controller, finishPhase } = makeController(true);

    await finishPhase({ stdout: bunSummary(7, 0), stderr: "" });

    expect(controller.summaryLines()).toBe(" 7 pass\n 0 fail\n");
  });
});

describe("createTestOutputController passedBanner", () => {
  test("prefixes the passed banner with the totalled summary", async () => {
    const { controller, finishPhase } = makeController(true);

    await finishPhase({ stdout: "", stderr: bunSummary(7, 0) });

    expect(controller.passedBanner()).toBe(" 7 pass\n 0 fail\n\n[run-tests] all phases passed\n");
  });

  test("returns the bare passed banner in verbose mode", async () => {
    const { controller } = makeController(false);

    expect(controller.passedBanner()).toBe("\n[run-tests] all phases passed\n");
  });
});
