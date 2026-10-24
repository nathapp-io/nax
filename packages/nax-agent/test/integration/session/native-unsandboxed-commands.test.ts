/**
 * US-003 end to end: a native session opened through the facade advertises
 * Bash's per-call `unsandboxed` argument when — and only when — the caller
 * opted in with `allowUnsandboxedCommands`.
 *
 * Read off the FIRST provider request of a turn rather than off the session:
 * the tool definitions sent to the model are exactly the advertisement that
 * matters, so a flag that reached the support but not the prompt would fail
 * here. The `gated` default and a stubbed available sandbox are the floor
 * US-001 requires before a "full" session opens at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, nativeBackend } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import {
  collect,
  installScriptedProvider,
  MODEL,
  resetScriptedProvider,
  sessionOptions,
  textRound,
} from "#test/helpers/agent-session";
import {
  cleanupTempDir,
  makeTempDir,
  stubSessionSandboxDeps,
  withDepsRestore,
  withSessionSandboxSeam,
} from "#test/helpers/index";

const tempDirs: string[] = [];
const sessionCleanups: (() => Promise<void>)[] = [];

function makeTestDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

async function closeTestSessions(): Promise<void> {
  const closed = await Promise.allSettled(sessionCleanups.splice(0).map(async (close) => close()));
  const errors = closed.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, "Failed to close test sessions");
}

afterEach(async () => {
  try {
    await closeTestSessions();
  } finally {
    for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
    resetScriptedProvider();
  }
});

/** The Bash tool's advertised `properties` keys in a full-profile session. */
async function bashPropertyKeys(options: { readonly allowUnsandboxedCommands?: boolean }): Promise<string[]> {
  const provider = installScriptedProvider();
  provider.push(textRound("ok"));
  const session = await createAgentSession(
    sessionOptions({
      profile: "full",
      workdir: makeTestDir("nax-unsandboxed-commands-"),
      backend: nativeBackend({
        model: MODEL,
        bashApproval: "gated",
        ...(options.allowUnsandboxedCommands === true ? { allowUnsandboxedCommands: true } : {}),
      }),
    }),
  );
  sessionCleanups.push(() => session.close());
  await collect(session.send("say ok"));

  const tools = provider.requests[0]?.tools ?? [];
  const bash = tools.find((tool) => tool.name === "Bash");
  if (bash === undefined)
    throw new Error(`the full profile must advertise Bash; saw ${tools.map((t) => t.name).join(", ")}`);
  const properties: unknown = bash.inputSchema.properties;
  if (typeof properties !== "object" || properties === null) {
    throw new Error("expected the Bash tool's inputSchema.properties to be an object");
  }
  return Object.keys(properties).sort();
}

describe("a native session's unsandboxedCommands option", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  test("AC-15: allowUnsandboxedCommands advertises the argument; the default does not", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    expect(await bashPropertyKeys({ allowUnsandboxedCommands: true })).toContain("unsandboxed");
    // A second session with no option: the schema is the pre-US-003 one.
    expect(await bashPropertyKeys({})).not.toContain("unsandboxed");
  });
});
