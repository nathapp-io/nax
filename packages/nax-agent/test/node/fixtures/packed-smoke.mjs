/**
 * Runs inside the temporary consumer that installed the packed nax-agent
 * tarball (S2 spec §7.3). Plain Node ESM: no repo imports, no test framework.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureCredentials,
  createAgentSession,
  createMemoryTranscriptStore,
  EMPTY_OWNED_PATHS_POLICY,
  globTool,
  NativeSessionAdapter,
  resetSandboxBackend,
  resumeAgentSession,
} from "@nathapp/nax-agent";
import {
  _agentSessionDeps,
  _clientDeps,
  DEFAULT_SANDBOX_CONFIG,
  resolveSessionSandbox,
} from "@nathapp/nax-agent/internal";

assert.equal(process.versions.bun, undefined, "the packed smoke must run on native Node");

const workdir = mkdtempSync(join(tmpdir(), "nax-packed-"));
writeFileSync(join(workdir, "hello.txt"), "hello");

// The credentials slot throws when unset (S1 D12); an embedder fills it the
// way nax's CLI does. The session turn below reads it before the stub client.
const configDir = join(workdir, "global-config");
mkdirSync(configDir, { recursive: true });
configureCredentials({
  configDir: () => configDir,
  readAuthConfig: async () => ({ source: "file", onChange: "warn" }),
});

// 1. One tool round-trip through the packed entry.
const globbed = await globTool.run(
  { pattern: "*.txt" },
  { root: workdir, resolvedPaths: [], maxBytes: 10_000, maxFileBytes: 10_000 },
);
assert.match(globbed.content, /hello\.txt/, `glob tool missed the file: ${globbed.content}`);

// 2. One native session turn against a stub client (the /internal seam the
//    package's own tests use; /internal ships in the tarball).
const model = {
  id: "packed-stub",
  provider: "stub",
  protocol: "stub",
  pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
};
_clientDeps.build = async () => ({
  model: async () => model,
  listModels: async () => [model],
  pricing: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
  stream: async function* () {
    yield { type: "text-delta", text: "packed-ok" };
    yield { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } };
    yield { type: "done", stopReason: "stop" };
  },
  complete: async () => ({ text: "packed-ok", usage: { inputTokens: 2, outputTokens: 3 }, stopReason: "stop" }),
  validate: () => {},
});
const transcriptDir = join(workdir, "transcripts");
mkdirSync(transcriptDir, { recursive: true });
const adapter = new NativeSessionAdapter();
const handle = await adapter.openSession("packed-smoke", {
  agentName: "native",
  workdir,
  resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  modelDef: { provider: "stub", model: "stub/packed-stub" },
  timeoutSeconds: 60,
  transcriptDir,
});
const turnEvents = [];
const turn = await adapter.sendTurn(handle, "hi", {
  interactionHandler: { onInteraction: async () => ({ answer: "" }) },
  onTurnEvent: (event) => turnEvents.push(event),
});
assert.equal(turn.output, "packed-ok", `unexpected turn output: ${turn.output}`);
assert.deepEqual(
  turnEvents.map((event) => event.type),
  ["text_delta", "usage"],
  `unexpected turn events: ${JSON.stringify(turnEvents)}`,
);
assert.equal(turnEvents[0].text, "packed-ok");

// An async sink that rejects must not become an unhandled rejection (Node's
// default ends the process on one). Bun's unit test cannot show Node's behaviour.
const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));
const again = await adapter.sendTurn(handle, "again", {
  interactionHandler: { onInteraction: async () => ({ answer: "" }) },
  onTurnEvent: async () => {
    throw new Error("async sink exploded");
  },
});
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(again.output, "packed-ok");
assert.deepEqual(unhandled, [], `unhandled rejections: ${unhandled.map(String).join("; ")}`);
await adapter.closeSession(handle);

// 3. Linux only (spec §7.3): one command through the real OS sandbox. A
//    missing sandbox FAILS here; CI installs bubblewrap.
if (process.platform === "linux") {
  try {
    const launcher = await resolveSessionSandbox({
      config: DEFAULT_SANDBOX_CONFIG,
      root: workdir,
      needsLauncher: true,
      // S3-2: ownedPaths is a required argument (no silent empty policy); an
      // embedder without owned paths passes the empty policy from the entry.
      ownedPaths: EMPTY_OWNED_PATHS_POLICY,
      protectedPaths: {
        gitExcludePathspecs: [],
        gitIgnorePatterns: [],
        projectStateDir: ".nax",
        credentialDir: join(workdir, ".credentials"),
        trustStoreFile: join(workdir, ".trust.json"),
      },
    });
    const result = await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo packed-sandbox" },
      root: workdir,
      cwd: workdir,
      timeoutMs: 30_000,
      stripEnvVars: [],
    });
    assert.equal(result.sandbox.wrapped, true, `sandbox was not applied: ${JSON.stringify(result.sandbox)}`);
    assert.equal(result.exitCode, 0, `sandboxed command failed: ${result.stderr}`);
    assert.match(result.stdout, /packed-sandbox/);
  } finally {
    // Linux's socat bridge keeps Node alive until the backend is reset.
    await resetSandboxBackend();
  }
}

// 4. The S3 chat round-trip (S3 spec §1): a multi-turn session with streamed
//    deltas, one embedder tool approved through answer(), one approval denied
//    by timeout, one cancel, and one resume from the store after a simulated
//    restart. Scripted provider; manual approval timers; memory credentials.
const requests = [];
let rounds = [];
const chatModel = { ...model, id: "chat-stub" };
_clientDeps.build = async () => ({
  model: async () => chatModel,
  listModels: async () => [chatModel],
  pricing: () => chatModel.pricing,
  stream(_model, req) {
    requests.push(req);
    const round = rounds.shift();
    if (round === undefined) throw new Error(`no scripted reply for request ${requests.length}`);
    return (async function* replay() {
      yield* round;
    })();
  },
  complete: async () => {
    throw new Error("round trips must stream");
  },
  validate: () => {},
});
const text = (value) => [
  { type: "text-delta", text: value },
  { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } },
  { type: "done", stopReason: "stop" },
];
const call = (id) => [
  { type: "tool-call", call: { id, name: "lookup", input: { id } } },
  { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } },
  { type: "done", stopReason: "tool_use" },
];

const timers = new Map();
let timerId = 0;
_agentSessionDeps.setTimeout = (fn, ms) => {
  timerId += 1;
  timers.set(timerId, { fn, ms });
  return timerId;
};
_agentSessionDeps.clearTimeout = (id) => {
  timers.delete(id);
};
const fireApprovalTimers = () => {
  for (const [id, timer] of [...timers]) {
    if (timer.ms !== 30_000) continue;
    timers.delete(id);
    timer.fn();
  }
};

const ran = [];
const chatOptions = {
  backend: "native",
  sessionId: "packed-chat",
  model: "stub/chat-stub",
  profile: "none",
  transcriptStore: createMemoryTranscriptStore(),
  credentials: { kind: "memory", credentials: { stub: { kind: "api-key", key: "sk-packed" } } },
  approvalTimeoutMs: 30_000,
  tools: [
    {
      name: "lookup",
      description: "look a record up",
      inputSchema: { type: "object" },
      approval: "always",
      async run(input) {
        ran.push(input);
        return { content: "record" };
      },
    },
  ],
};
const chat = await createAgentSession(chatOptions);

async function turnOf(session, message, onApproval) {
  const events = [];
  for await (const event of session.send(message)) {
    events.push(event);
    if (event.type === "approval_requested") onApproval(session, event);
  }
  return events;
}
const endOf = (events) => events.at(-1);

// Turn 1: approved through answer().
rounds = [call("c1"), text("found it")];
const approved = await turnOf(chat, "find c1", (session, event) => {
  assert.equal(session.answer(event.requestId, { decision: "allow" }), "accepted");
});
assert.ok(
  approved.some((event) => event.type === "text_delta"),
  "no streamed delta",
);
assert.equal(endOf(approved).status, "completed", JSON.stringify(endOf(approved)));
assert.deepEqual(ran, [{ id: "c1" }]);

// Turn 2: the approval is denied by its timeout.
rounds = [call("c2"), text("never mind")];
const timedOut = await turnOf(chat, "find c2", () => fireApprovalTimers());
assert.ok(
  timedOut.some((event) => event.type === "approval_resolved" && event.decidedBy === "timeout"),
  `no timeout: ${JSON.stringify(timedOut.map((event) => event.type))}`,
);
assert.deepEqual(ran, [{ id: "c1" }], "a timed-out approval ran the tool");

// Turn 3: cancelled while the approval waits.
rounds = [call("c3")];
const cancelled = await turnOf(chat, "find c3", (session) => session.cancel("stop"));
assert.equal(endOf(cancelled).status, "cancelled");
await chat.close();

// A restart: the process died after markTurn(running) of a later turn.
await chatOptions.transcriptStore.markTurn("packed-chat", { turnId: "t-dead", state: "running" });
const resumed = await resumeAgentSession("packed-chat", chatOptions);
assert.deepEqual(resumed.lastTurn, { turnId: "t-dead", status: "interrupted" });
rounds = [text("resumed")];
const after = await turnOf(resumed, "still there?", () => {});
assert.equal(endOf(after).output, "resumed");
const history = requests.at(-1).messages;
assert.deepEqual(history[0], { role: "user", content: "find c1" }, "resume lost the history");
await resumed.close();

console.log("packed smoke ok");
