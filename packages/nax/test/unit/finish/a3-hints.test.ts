// test/unit/finish/a3-hints.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { _a3HintsDeps, readA3Hints } from "@/finish/a3-hints";

const original = { ..._a3HintsDeps };
afterEach(() => Object.assign(_a3HintsDeps, original));

function record(mode: "on" | "shadow", parsed: boolean) {
  return JSON.stringify({
    mode,
    parsed,
    findings: [
      { index: 1, severity: "info", category: "convention", file: "src/a.ts", line: 3, message: "stale comment" },
      { index: 2, severity: "warning", category: "input", file: "src/b.ts", message: "empty list" },
    ],
    verdicts: [
      { index: 1, verdict: "skip", reason: "only matters if code changes" },
      { index: 2, verdict: "fix", reason: "real" },
    ],
  });
}

function stubFiles(files: Record<string, string>) {
  _a3HintsDeps.listJson = async () => Object.keys(files);
  _a3HintsDeps.readText = async (p) => {
    const text = files[p];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  };
}

describe("readA3Hints", () => {
  test("returns skip verdicts joined to their finding, from on+parsed records only", async () => {
    stubFiles({ "/out/nbf-worth-check/feat/US-1-1.json": record("on", true) });
    expect(await readA3Hints("/out", "feat")).toEqual([
      { file: "src/a.ts", line: 3, severity: "info", message: "stale comment", reason: "only matters if code changes" },
    ]);
  });

  test("ignores shadow and unparsed records", async () => {
    stubFiles({
      "/out/nbf-worth-check/feat/US-1-1.json": record("shadow", true),
      "/out/nbf-worth-check/feat/US-2-1.json": record("on", false),
    });
    expect(await readA3Hints("/out", "feat")).toEqual([]);
  });

  test("absent directory reads as no hints", async () => {
    _a3HintsDeps.listJson = async () => {
      throw new Error("ENOENT");
    };
    expect(await readA3Hints("/out", "feat")).toEqual([]);
  });

  test("a malformed file is skipped, others still read", async () => {
    stubFiles({
      "/out/nbf-worth-check/feat/bad.json": "{not json",
      "/out/nbf-worth-check/feat/US-1-1.json": record("on", true),
    });
    expect((await readA3Hints("/out", "feat")).length).toBe(1);
  });

  test("a verdict index with no matching finding is dropped", async () => {
    stubFiles({
      "/out/nbf-worth-check/feat/x.json": JSON.stringify({
        mode: "on",
        parsed: true,
        findings: [],
        verdicts: [{ index: 7, verdict: "skip", reason: "r" }],
      }),
    });
    expect(await readA3Hints("/out", "feat")).toEqual([]);
  });
});
