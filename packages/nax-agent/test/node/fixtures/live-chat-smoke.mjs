/**
 * S3 acceptance 10.2: a real-provider chat on Node. Two turns and one embedder
 * tool with an approval. BILLED: run only with the maintainer's approval at
 * launch (RELEASING.md, "S3 acceptance"). Runs inside a temporary consumer that
 * installed the packed tarball. Credentials come from nax's global config
 * directory, read the way nax's CLI reads them.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  configureCredentials,
  createAgentSession,
  createMemoryTranscriptStore,
  nativeBackend,
} from "@nathapp/nax-agent";

assert.equal(process.versions.bun, undefined, "the live chat smoke must run on native Node");

const model = process.env.NAX_AGENT_LIVE_MODEL ?? "minimax/MiniMax-M2.7";
const configDir = process.env.NAX_GLOBAL_CONFIG_DIR ?? join(homedir(), ".nax");
// nax's global auth section with its schema defaults, as test/preload.ts reads it.
async function readAuthConfig() {
  const file = join(configDir, "config.json");
  const auth = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).auth : undefined) ?? {};
  const exec = auth.exec === undefined ? undefined : { ...auth.exec, timeoutMs: auth.exec.timeoutMs ?? 10_000 };
  return { source: auth.source ?? "file", onChange: auth.onChange ?? "warn", ...(exec === undefined ? {} : { exec }) };
}
configureCredentials({ configDir: () => configDir, readAuthConfig });

const runs = [];
const lookupOrder = {
  name: "lookup_order",
  description: "Look up an order by its numeric id. Returns the order's status and carrier.",
  inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  approval: "always",
  async run(input) {
    runs.push(input);
    return { content: JSON.stringify({ id: input?.id, status: "shipped", carrier: "DHL" }) };
  },
};

const session = await createAgentSession({
  backend: nativeBackend({ model }),
  profile: "none",
  transcriptStore: createMemoryTranscriptStore(),
  tools: [lookupOrder],
  instructions: "You are a support assistant. Use the tools you are given when asked. Keep replies short.",
  turnTimeoutSeconds: 300,
});

async function turn(message) {
  const events = [];
  for await (const event of session.send(message)) {
    events.push(event);
    if (event.type === "approval_requested") {
      console.log(`approval_requested: ${event.tool} ${event.summary}`);
      assert.equal(session.answer(event.requestId, { decision: "allow" }), "accepted");
    }
  }
  const end = events.at(-1);
  console.log(`turn_end ${end.status} $${end.costUsd.toFixed(4)} ${JSON.stringify(end.output).slice(0, 200)}`);
  return events;
}

const first = await turn("Please look up order 42 with the lookup_order tool and tell me its status.");
const firstEnd = first.at(-1);
assert.equal(firstEnd.type, "turn_end");
assert.equal(firstEnd.status, "completed", JSON.stringify(firstEnd.error));
assert.ok(
  first.some((event) => event.type === "text_delta"),
  "no streamed text_delta",
);
assert.ok(
  first.some(
    (event) => event.type === "approval_resolved" && event.decision === "allow" && event.decidedBy === "human",
  ),
  "the approval was not answered by a human",
);
assert.ok(runs.length >= 1, "the embedder tool never ran");
assert.ok(
  first.some((event) => event.type === "tool_result" && !event.isError),
  "no successful tool_result",
);

const second = await turn("Which carrier is shipping it? Answer from what you already found.");
const secondEnd = second.at(-1);
assert.equal(secondEnd.status, "completed", JSON.stringify(secondEnd.error));
assert.match(secondEnd.output, /dhl/i, "the second turn did not recall the tool result");

await session.close();
const total = firstEnd.costUsd + secondEnd.costUsd;
console.log(`live chat smoke ok (model ${model}, $${total.toFixed(4)})`);
