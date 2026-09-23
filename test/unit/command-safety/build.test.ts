import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mockFetch, stubAnswerBody, withTempDir } from "@test/helpers";
import { _systemOneClientDeps, buildCommandShadow, COMMAND_SAFETY_DIR } from "@/command-safety";

let orig: typeof _systemOneClientDeps;
let auth: (string | null)[];
beforeEach(() => {
  orig = { ..._systemOneClientDeps };
  auth = [];
  _systemOneClientDeps.fetch = mockFetch(async (_url, init) => {
    auth.push(new Headers(init?.headers).get("authorization"));
    return Response.json(stubAnswerBody());
  });
});
afterEach(() => Object.assign(_systemOneClientDeps, orig));

const shadowConfig = { shadow: { url: "http://127.0.0.1:1/x", timeoutMs: 3000, authEnv: "NAX_TEST_AUTH" } };

describe("buildCommandShadow", () => {
  test("no config, or no shadow block -> undefined (off)", () => {
    expect(buildCommandShadow({ config: undefined, outputDir: "/x", runId: "r", env: {} })).toBeUndefined();
    expect(buildCommandShadow({ config: {}, outputDir: "/x", runId: "r", env: {} })).toBeUndefined();
  });

  test("writes rows to <outputDir>/command-safety/<runId>.jsonl, with the token from the named env var", async () => {
    await withTempDir(async (dir) => {
      const shadow = buildCommandShadow({
        config: shadowConfig,
        outputDir: dir,
        runId: "run-7",
        storyId: "US-1",
        env: { NAX_TEST_AUTH: "abc" },
      });
      shadow?.observe("k", {
        command: "ls",
        identity: "Bash",
        stage: "run",
        mechanical: { verdict: "allow", breach: false },
      });
      shadow?.settle("k", { ledger: "ok" });
      await shadow?.drain();
      const line = readFileSync(join(dir, COMMAND_SAFETY_DIR, "run-7.jsonl"), "utf8").trim();
      expect(JSON.parse(line).model.status).toBe("answered");
      expect(auth).toEqual(["Bearer abc"]);
    });
  });

  test("an unset token env var sends no Authorization header", async () => {
    await withTempDir(async (dir) => {
      const shadow = buildCommandShadow({ config: shadowConfig, outputDir: dir, runId: "r", env: {} });
      shadow?.observe("k", {
        command: "ls",
        identity: "Bash",
        stage: "run",
        mechanical: { verdict: "allow", breach: false },
      });
      shadow?.settle("k", { ledger: "ok" });
      await shadow?.drain();
      expect(auth).toEqual([null]);
    });
  });
});
