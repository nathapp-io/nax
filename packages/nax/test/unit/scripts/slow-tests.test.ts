import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../../scripts/slow-tests.ts");

async function report(xml: string, args: string[] = []) {
  const proc = Bun.spawn([process.execPath, SCRIPT, "--tsv", ...args], {
    stdin: new Blob([xml]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return stdout.trim().split("\n").slice(1);
}

describe("slow-tests report", () => {
  test.each([
    ["test/unit/execution/batch.test.ts", "batching"],
    ["packages/nax/test/unit/execution/batch.test.ts", "batching"],
    ["packages/nax-agent/test/unit/session.test.ts", "session &amp; tools"],
    ["packages/nax/test/ui/stream.test.tsx", "stream"],
  ])("uses Bun's file attribute for %s", async (file, classname) => {
    const rows = await report(
      `<testsuites><testcase name="dispatches" classname="${classname}" file="${file}" time="0.125" /></testsuites>`,
    );
    expect(rows).toEqual([`1\t125\tpass\t${file}\tdispatches`]);
  });

  test("keeps legacy classname paths, including their workspace prefix", async () => {
    const rows = await report(`<testsuites>
      <testcase name="legacy" classname="packages/nax/test/unit/batch.test.ts" time="0.125" />
      <testcase name="local" classname="test/unit/batch.test.ts" time="0.1" />
    </testsuites>`);
    expect(rows).toEqual([
      "1\t125\tpass\tpackages/nax/test/unit/batch.test.ts\tlegacy",
      "2\t100\tpass\ttest/unit/batch.test.ts\tlocal",
    ]);
  });

  test("ranks and filters cases while keeping failure status and XML names", async () => {
    const rows = await report(
      `<testsuites>
        <testcase name="fast" file="test/unit/fast.test.ts" time="0.001" />
        <testcase name="skipped" file="test/unit/skip.test.ts" time="0.1"><skipped /></testcase>
        <testcase name="slow &amp; failed" file="test/unit/slow.test.ts" time="0.3"><failure message="failed" /></testcase>
        <testcase name="middle" file="test/unit/middle.test.ts" time="0.2" />
      </testsuites>`,
      ["--top=2", "--min=100"],
    );
    expect(rows).toEqual([
      "1\t300\tfail\ttest/unit/slow.test.ts\tslow & failed",
      "2\t200\tpass\ttest/unit/middle.test.ts\tmiddle",
    ]);
  });
});
