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
  eventsOf,
  installScriptedProvider,
  MODEL,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  toolRound,
} from "#test/helpers/agent-session";
import {
  assertDefined,
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
  // Deliberately built through the shared `sessionOptions` factory with NO
  // explicit `backend`: the option is a native-only key, so this also pins that
  // the factory routes it into `nativeBackend()` instead of dropping it. A
  // session opened here therefore really has the option on, which is what the
  // advertisement assertion below is worth.
  const session = await createAgentSession(
    sessionOptions({
      profile: "full",
      workdir: makeTestDir("nax-unsandboxed-commands-"),
      bashApproval: "gated",
      ...(options.allowUnsandboxedCommands === true ? { allowUnsandboxedCommands: true } : {}),
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

/**
 * US-005 AC-17: the argument the advertisement introduced is SCHEMA-CHECKED at
 * the transport, before any handler runs. `unsandboxed` is a boolean in an
 * opted-in session's Bash schema (US-003), so a model that spells it `"true"`
 * gets a model-facing invalid-input result naming the property and the type it
 * wanted — and the command never executes. That matters because the runtime
 * reads only `=== true`: an unchecked string would quietly run as an ordinary
 * call, which is precisely the ambiguity the schema exists to remove.
 */
describe("a native session rejects a non-boolean unsandboxed argument", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  test("AC-17: the model is told unsandboxed expected boolean, and nothing runs", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "c1", name: "Bash", input: { command: "ls", unsandboxed: "true" } }]),
      textRound("ok"),
    );
    const session = await createAgentSession(
      sessionOptions({
        profile: "full",
        workdir: makeTestDir("nax-unsandboxed-input-"),
        backend: nativeBackend({ model: MODEL, bashApproval: "gated", allowUnsandboxedCommands: true }),
      }),
    );
    sessionCleanups.push(() => session.close());

    const events = await collect(session.send("run ls"));

    const [result] = eventsOf(events, "tool_result").filter((event) => event.callId === "c1");
    assertDefined(result, "the tool result for the rejected call");
    expect(result.isError).toBe(true);
    expect(result.preview).toContain("unsandboxed");
    expect(result.preview).toContain("boolean");
    expect(result.preview).toContain("was not executed");
    // The tool never executed: no command reached the sandbox's wrap.
    expect(seam.backend.calls).toEqual([]);
  });
});
