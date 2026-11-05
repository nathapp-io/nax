import { afterEach, expect, test } from "bun:test";
import {
  assertDefined,
  CHAT_MODEL,
  makeAgentResource,
  makeSubagentHostHarness,
  type SubagentHostHarness,
} from "@test/helpers";

let harness: SubagentHostHarness | undefined;
afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

test("AC-12 the host-built run tool opens the nested session on the overridden model", async () => {
  const h = makeSubagentHostHarness({
    agents: [makeAgentResource({ name: "reviewer", model: "haiku" })],
    skipRun: true,
  });
  harness = h;
  await h.host.start({ mode: "guarded", model: CHAT_MODEL });
  const tool = (await h.agentsProvider()?.tools("/repo"))?.find((t) => t.localName === "run");
  assertDefined(tool, "run tool");
  await tool.run(
    { agent: "reviewer", task: "check it", model: "openai-codex/gpt-6-luna" },
    { root: "/repo", resolvedPaths: [], maxBytes: 1_000_000, maxFileBytes: 1_000_000 },
  );
  expect(h.nestedBackends.map((options) => options.model)).toEqual(["openai-codex/gpt-6-luna"]);
});
