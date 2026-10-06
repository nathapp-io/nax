import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptDoc } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import type { CapabilityRecord } from "#src/client/capabilities";
import { resolveAcpOptions } from "#src/client/options";
import {
  canRestore,
  checkRestored,
  isUsableSessionId,
  MAX_SESSION_ID_CHARS,
  type Restore,
  storedSessionOf,
} from "#src/client/resume";
import { CLAUDE_CONFIG_OPTIONS } from "#test/fixtures/fake-agent/script";
import { naxError, sessionError, thrown } from "#test/helpers/errors";
import { openContext } from "#test/helpers/open-context";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-resume-unit-");
});
afterEach(() => cleanupTempDir(dir));

const OPTIONS = resolveAcpOptions({ agent: "claude", allowUnsandboxed: true, command: "fake-claude" }, { PATH: "" });

function docWith(acp: unknown, backend = "acp:claude"): TranscriptDoc {
  return JSON.parse(JSON.stringify({ backend, acp, messages: [], savedAt: "t" }));
}

const RECORD: CapabilityRecord = {
  protocolVersion: 1,
  loadSession: false,
  resume: false,
  close: false,
  mcpHttp: false,
  readOnlyMode: true,
  preApproval: true,
};

describe("storedSessionOf (spec §6.9 step 1, S4-6 D6-b, D6-c)", () => {
  test("a valid record: the stored id, the stored cwd spelling and the cost baseline", () => {
    const restore = storedSessionOf(
      docWith({ agentSessionId: "a-1", agent: "claude", cwd: dir, costUsd: 0.02 }),
      openContext(dir),
      OPTIONS,
    );
    expect(restore).toEqual({ agentSessionId: "a-1", cwd: dir, costUsd: 0.02 });
  });

  test("another backend kind: BACKEND_MISMATCH", () => {
    const err = sessionError(
      thrown(() =>
        storedSessionOf(
          docWith({ agentSessionId: "a-1", agent: "claude", cwd: dir }, "native"),
          openContext(dir),
          OPTIONS,
        ),
      ),
    );
    expect(err.code).toBe("AGENT_SESSION_BACKEND_MISMATCH");
  });

  test("a document without backend reads as native: BACKEND_MISMATCH", () => {
    const doc: TranscriptDoc = JSON.parse(JSON.stringify({ messages: [], savedAt: "t" }));
    expect(sessionError(thrown(() => storedSessionOf(doc, openContext(dir), OPTIONS))).code).toBe(
      "AGENT_SESSION_BACKEND_MISMATCH",
    );
  });

  test.each([
    ["no acp record", undefined],
    ["acp is not an object", "x"],
    ["empty agentSessionId", { agentSessionId: "", agent: "claude", cwd: "/w" }],
    ["non-string agentSessionId", { agentSessionId: 7, agent: "claude", cwd: "/w" }],
    ["oversized agentSessionId", { agentSessionId: "a".repeat(MAX_SESSION_ID_CHARS + 1), agent: "claude", cwd: "/w" }],
    ["no agent", { agentSessionId: "a-1", cwd: "/w" }],
    ["empty cwd", { agentSessionId: "a-1", agent: "claude", cwd: "" }],
    ["another agent under the same kind", { agentSessionId: "a-1", agent: "codex", cwd: "/w" }],
  ])("%s: TRANSCRIPT_CORRUPT (Review Focus 5)", (_label, acp) => {
    const err = naxError(thrown(() => storedSessionOf(docWith(acp), openContext(dir), OPTIONS)));
    expect(err.code).toBe("TRANSCRIPT_CORRUPT");
  });

  test.each([-1, "0.5", Number.NaN, null])("a costUsd of %p seeds 0 (Review Focus 5)", (costUsd) => {
    const restore = storedSessionOf(
      docWith({ agentSessionId: "a-1", agent: "claude", cwd: dir, costUsd }),
      openContext(dir),
      OPTIONS,
    );
    expect(restore.costUsd).toBe(0);
  });

  test("another directory: INVALID_OPTIONS on workdir", () => {
    const other = join(dir, "other");
    mkdirSync(other);
    const err = sessionError(
      thrown(() =>
        storedSessionOf(docWith({ agentSessionId: "a-1", agent: "claude", cwd: dir }), openContext(other), OPTIONS),
      ),
    );
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(err.context).toMatchObject({ path: "workdir" });
  });

  test("the same directory through a symlink or a trailing slash is accepted; the stored spelling is kept (Review Focus 1)", () => {
    const real = join(dir, "real");
    mkdirSync(real);
    const link = join(dir, "link");
    symlinkSync(real, link);
    const viaLink = storedSessionOf(
      docWith({ agentSessionId: "a-1", agent: "claude", cwd: link }),
      openContext(real),
      OPTIONS,
    );
    expect(viaLink.cwd).toBe(link);
    const slashed = storedSessionOf(
      docWith({ agentSessionId: "a-1", agent: "claude", cwd: `${real}/` }),
      openContext(real),
      OPTIONS,
    );
    expect(slashed.cwd).toBe(`${real}/`);
  });
});

describe("checkRestored (spec §6.9 step 3, S4-6 D6-d, D6-k)", () => {
  const restore: Restore = { agentSessionId: "a-1", cwd: "/w", costUsd: 0 };

  test("the stored id echoed, or none echoed: accepted with the agent's config options", () => {
    const options = [...CLAUDE_CONFIG_OPTIONS];
    expect(checkRestored(restore, "resume", JSON.parse('{"sessionId": "a-1"}'))).toEqual({
      agentSessionId: "a-1",
      cwd: "/w",
      configOptions: [],
      restoredWith: "resume",
    });
    expect(checkRestored(restore, "load", { configOptions: options }).configOptions).toEqual(options);
  });

  test("another id echoed: AGENT_SESSION_TURN_FAILED, detail identity", () => {
    const err = naxError(thrown(() => checkRestored(restore, "resume", JSON.parse('{"sessionId": "someone-else"}'))));
    expect(err.code).toBe("AGENT_SESSION_TURN_FAILED");
    expect(err.context).toMatchObject({ detail: "identity" });
  });

  test("a load answered with null: no config options (D6-k)", () => {
    expect(checkRestored(restore, "load", JSON.parse("null")).configOptions).toEqual([]);
  });
});

describe("helpers", () => {
  test("isUsableSessionId", () => {
    expect(isUsableSessionId("a")).toBe(true);
    expect(isUsableSessionId("")).toBe(false);
    expect(isUsableSessionId(3)).toBe(false);
    expect(isUsableSessionId("a".repeat(MAX_SESSION_ID_CHARS + 1))).toBe(false);
  });

  test("canRestore: session/resume or session/load", () => {
    expect(canRestore(RECORD)).toBe(false);
    expect(canRestore({ ...RECORD, resume: true })).toBe(true);
    expect(canRestore({ ...RECORD, loadSession: true })).toBe(true);
  });
});
