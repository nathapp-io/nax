import { afterAll, describe, expect, test } from "bun:test";
import { createSrtBackend, probeSandbox } from "@/sandbox";

const backend = createSrtBackend({});
const probe = await probeSandbox(backend);
const label = probe.available ? "available" : `SKIPPED: ${probe.reason}`;

describe(`srt backend (${label})`, () => {
  afterAll(() => backend.reset());

  test.skipIf(!probe.available)("open network: the wrapped argv sets no proxy variables", async () => {
    const argv = await backend.wrap({
      command: "true",
      shell: "/bin/sh",
      policy: { writeRoots: [process.cwd()], denyWrite: [], denyRead: [], network: {} },
      cwd: process.cwd(),
      commandId: "t1",
    });
    backend.commandFinished();
    expect(argv.join(" ")).not.toContain("HTTPS_PROXY=");
  });

  test.skipIf(!probe.available)("wrap returns argv only -- the backend's env never crosses (F6)", async () => {
    const argv = await backend.wrap({
      command: "true",
      shell: "/bin/sh",
      policy: { writeRoots: [process.cwd()], denyWrite: [], denyRead: [], network: {} },
      cwd: process.cwd(),
      commandId: "t2",
    });
    backend.commandFinished();
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.every((a) => typeof a === "string")).toBe(true);
  });
});
