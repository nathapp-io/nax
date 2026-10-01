import { describe, expect, test } from "bun:test";
import { createTestOutputController } from "@scripts/run-tests-output";

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
