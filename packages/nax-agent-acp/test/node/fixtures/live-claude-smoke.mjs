/**
 * S4 acceptance §11.2: the live Claude smoke. BILLED: run only with the
 * maintainer's approval at launch (RELEASING.md, "S4 acceptance"). Runs on Node
 * inside a temporary consumer that installed the packed @nathapp/nax-agent and
 * @nathapp/nax-agent-acp. Claude Code authenticates itself: an existing `claude`
 * login, or ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN in the environment.
 * NAX_AGENT_ACP_LIVE_MODEL picks a model (the agent's default otherwise).
 *
 *   node live-claude-smoke.mjs                                   all phases
 *   node live-claude-smoke.mjs --resume-child <workdir> <store>  phase E's second process (internal)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createFileTranscriptStore,
  createMemoryTranscriptStore,
  resumeAgentSession,
} from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";

assert.equal(process.versions.bun, undefined, "the live smoke must run on native Node");

const model = process.env.NAX_AGENT_ACP_LIVE_MODEL;
const TURN_SECONDS = 300;
const costs = [];
const results = [];

const backend = () =>
  acpBackend({
    agent: "claude",
    allowUnsandboxed: true,
    initializeTimeoutMs: 180_000,
    ...(model === undefined ? {} : { model }),
  });
const dir = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const usageOf = (events) => events.find((event) => event.type === "usage");

async function turn(session, message, onEvent = () => {}) {
  const events = [];
  for await (const event of session.send(message)) {
    events.push(event);
    onEvent(event);
  }
  const end = events.at(-1);
  const costText = typeof end.costUsd === "number" ? end.costUsd.toFixed(4) : "n/a";
  console.log(`  turn_end ${end.status} $${costText} ${JSON.stringify(end.output).slice(0, 160)}`);
  assert.equal(end.status, "completed", JSON.stringify(end.error));
  costs.push(end.costUsd);
  return events;
}

const allowAll = (session) => (event) => {
  if (event.type === "approval_requested") session.answer(event.requestId, { decision: "allow" });
};

function lookupTool(runs) {
  return {
    name: "lookup_order",
    description: "Look up an order by its numeric id. Returns the order's status.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    approval: "never",
    async run(input) {
      runs.push(input);
      return { content: JSON.stringify({ id: input?.id, status: "shipped" }) };
    },
  };
}

/** A: ask profile; an approved edit lands; a file read pairs tool_call/tool_result; usage is reported and per turn. */
async function phaseAsk() {
  const workdir = dir("acp-live-ask-");
  writeFileSync(join(workdir, "notes.txt"), "alpha\n");
  const session = await createAgentSession({
    backend: backend(),
    profile: "ask",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
    turnTimeoutSeconds: TURN_SECONDS,
  });
  const approvals = [];
  const first = await turn(
    session,
    "Read notes.txt with your Read tool, then use your Edit tool to replace the word alpha with beta. Do not use Bash.",
    (event) => {
      if (event.type !== "approval_requested") return;
      approvals.push(event.tool);
      assert.equal(session.answer(event.requestId, { decision: "allow" }), "accepted");
    },
  );
  assert.ok(approvals.length >= 1, "no approval_requested under ask");
  assert.match(readFileSync(join(workdir, "notes.txt"), "utf8"), /beta/, "the approved edit did not land");
  const read = first.find((e) => e.type === "tool_call" && JSON.stringify(e.input).includes("notes.txt"));
  assert.ok(read, "no tool_call whose input names notes.txt");
  assert.ok(
    first.some((e) => e.type === "tool_result" && e.callId === read.callId),
    "the read's tool_call has no tool_result",
  );
  const u1 = usageOf(first);
  assert.ok(u1 && u1.outputTokens > 0 && u1.inputTokens + (u1.cacheRead ?? 0) > 0, "turn 1 usage has no tokens");
  assert.equal(u1.costSource, "reported", "turn 1 cost is not reported");
  const second = await turn(session, "Reply with the single word: done.", allowAll(session));
  const u2 = usageOf(second);
  assert.ok(
    u2.outputTokens < u1.outputTokens,
    `turn 2 output ${u2.outputTokens} looks cumulative (turn 1: ${u1.outputTokens})`,
  );
  results.push({ phase: "ask", approvals, turn1: u1, turn2: u2, capabilities: session.backend.capabilities });
  await session.close();
}

/** B and C: the embedder tool through MCP without a permission prompt; under read, a write is rejected by profile. */
async function phaseTool(profile) {
  const workdir = dir(`acp-live-${profile}-`);
  const runs = [];
  const session = await createAgentSession({
    backend: backend(),
    profile,
    workdir,
    tools: [lookupTool(runs)],
    transcriptStore: createMemoryTranscriptStore(),
    turnTimeoutSeconds: TURN_SECONDS,
  });
  const events = await turn(session, "Use the lookup_order tool to look up order 42 and tell me its status.");
  assert.ok(runs.length >= 1, `the embedder tool never ran under ${profile}`);
  assert.ok(
    !events.some((e) => e.type === "approval_requested" && e.tool.includes("lookup_order")),
    `the embedder tool met a permission prompt under ${profile}`,
  );
  const result = { phase: profile, toolRuns: runs.length };
  if (profile === "read") {
    // turn() already requires the turn to complete (no ExitPlanMode cancel, #2365).
    const write = await turn(session, "Now create a file named created.txt containing the word hello.");
    const resolved = write.filter((e) => e.type === "approval_resolved");
    assert.ok(!existsSync(join(workdir, "created.txt")), "a write landed under read");
    assert.ok(!resolved.some((e) => e.decision === "allow"), "a permission request was allowed under read");
    // Recorded, not required: plan mode may refuse the write itself, without asking.
    result.profileDenials = resolved.filter((e) => e.decidedBy === "profile" && e.decision === "deny").length;
  }
  results.push(result);
  await session.close();
}

/** D: a question round trip, if Claude emits an elicitation. Not observed is recorded, not failed. */
async function phaseQuestion() {
  const session = await createAgentSession({
    backend: backend(),
    profile: "ask",
    workdir: dir("acp-live-q-"),
    transcriptStore: createMemoryTranscriptStore(),
    turnTimeoutSeconds: TURN_SECONDS,
  });
  let asked = false;
  const events = await turn(
    session,
    "Use your AskUserQuestion tool to ask me whether I prefer red or blue, then tell me which I chose.",
    (event) => {
      if (event.type === "question") {
        asked = true;
        session.answer(event.requestId, { text: "blue" });
      }
      allowAll(session)(event);
    },
  );
  if (asked) assert.match(events.at(-1).output, /blue/i, "the answer did not reach the agent");
  else console.log("  question: not observed (recorded, not failed)");
  results.push({ phase: "question", observed: asked });
  await session.close();
}

/** E: a nonce survives close and resumeAgentSession in a new process, through session/resume. */
async function phaseResume() {
  const workdir = dir("acp-live-resume-");
  const storeDir = dir("acp-live-store-");
  const nonce = randomBytes(4).toString("hex");
  const session = await createAgentSession({
    backend: backend(),
    profile: "full",
    workdir,
    transcriptStore: createFileTranscriptStore(storeDir),
    sessionId: "live-resume",
    turnTimeoutSeconds: TURN_SECONDS,
  });
  await turn(session, `Remember this code word for later: ${nonce}. Reply only with OK.`);
  await session.close();
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--resume-child", workdir, storeDir], {
    encoding: "utf8",
    timeout: 600_000,
    env: process.env,
  });
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  assert.equal(child.status, 0, "the resume child failed");
  const line = (child.stdout ?? "").split("\n").find((l) => l.startsWith("RESUME_RESULT "));
  assert.ok(line, "the resume child printed no result");
  const result = JSON.parse(line.slice("RESUME_RESULT ".length));
  assert.equal(result.restoredWith, "resume", "session/resume was not used");
  assert.ok(result.output.includes(nonce), "the resumed agent did not return the nonce");
  costs.push(result.costUsd);
  results.push({ phase: "resume", ...result });
}

async function resumeChild(workdir, storeDir) {
  const session = await resumeAgentSession("live-resume", {
    backend: backend(),
    profile: "full",
    workdir,
    transcriptStore: createFileTranscriptStore(storeDir),
    turnTimeoutSeconds: TURN_SECONDS,
  });
  const restoredWith = session.backend.capabilities.restoredWith;
  const events = [];
  for await (const event of session.send("What was the code word I gave you? Reply with the code word only.")) {
    events.push(event);
  }
  const end = events.at(-1);
  await session.close();
  // D6-a: the first resumed turn's cost is its own share; recorded for the master plan.
  console.log(
    `RESUME_RESULT ${JSON.stringify({ restoredWith, status: end.status, output: end.output, costUsd: end.costUsd, usage: usageOf(events) })}`,
  );
}

if (process.argv[2] === "--resume-child") {
  await resumeChild(process.argv[3], process.argv[4]);
} else {
  console.log("phase A: ask");
  await phaseAsk();
  console.log("phase B: embedder tool under full");
  await phaseTool("full");
  console.log("phase C: embedder tool and a write under read");
  await phaseTool("read");
  console.log("phase D: question");
  await phaseQuestion();
  console.log("phase E: resume");
  await phaseResume();
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  console.log(
    JSON.stringify({ model: model ?? "agent default", totalUsd: Number(total.toFixed(4)), results }, null, 2),
  );
  console.log(`live claude smoke ok ($${total.toFixed(4)})`);
}
