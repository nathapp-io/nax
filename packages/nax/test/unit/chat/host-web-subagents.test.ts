import { afterEach, expect, test } from "bun:test";
import { type AskRequest, compileToolPolicy, createCodingToolRuntime } from "@nathapp/nax-agent";
import {
  approvalRequestedEvent,
  assertDefined,
  CHAT_MODEL,
  fetchChatPage,
  makeAgentResource,
  makeChatWebHarness,
  makeSubagentHostHarness,
  waitForCondition,
} from "@test/helpers";
import { createChatAskController } from "@/chat/ask-controller";
import { _openChatSessionDeps } from "@/chat/open-chat-session";
import type { ChatWeb } from "@/chat/web/wiring";

let h: ReturnType<typeof makeSubagentHostHarness> | undefined;
let webHarness: ReturnType<typeof makeChatWebHarness> | undefined;
let web: ChatWeb | undefined;
afterEach(async () => {
  await h?.dispose();
  await webHarness?.dispose();
  h = undefined;
  webHarness = undefined;
  web = undefined;
});
function setup(options: Parameters<typeof makeSubagentHostHarness>[0] = {}) {
  webHarness = makeChatWebHarness();
  const host = makeSubagentHostHarness({ agents: [makeAgentResource()], ...options });
  h = host;
  Object.assign(host.config, { chat: webHarness.config.chat });
  _openChatSessionDeps.createChatWeb = async (p) => {
    const result = await webHarness?.deps.createChatWeb(p);
    web = result?.web;
    return result ?? {};
  };
  return host;
}
test("AC-12 current exposes the open handle's web guard", async () => {
  const host = setup();
  await host.host.start({ mode: "full", model: CHAT_MODEL });
  assertDefined(web);
  expect(host.host.current().webGuard).toBe(web.guard);
});
test("AC-13 a nested native backend receives the parent guard", async () => {
  const host = setup();
  await host.host.start({ mode: "full", model: CHAT_MODEL });
  await host.host.send("go", () => {});
  assertDefined(web);
  expect(host.nestedBackends[0]?.hostPorts?.webExposure).toBe(web.guard);
});
test.each([
  ["AC-18", ["bun", "nax.js"], ["nax-jobs", "nax-tasks", "nax-agents"]],
  ["AC-19", undefined, ["nax-tasks", "nax-agents"]],
] as const)("%s per-session web leaves host provider tails unchanged", async (_ac, naxEntry, tail) => {
  const host = setup({ ...(naxEntry ? { naxEntry } : {}), skipRun: true });
  await host.host.start({ mode: "full", model: CHAT_MODEL });
  const ids = host.chatBackends[0]?.toolProviders?.map((p) => p.id);
  expect(ids).toContain("web");
  expect(ids?.filter((id) => id !== "web").slice(-tail.length)).toEqual([...tail]);
  expect(host.resources.toolProviders.map((p) => p.id)).not.toContain("web");
});
test("AC-20 subagents receive exactly resource providers and never the web tools", async () => {
  const host = setup();
  await host.host.start({ mode: "full", model: CHAT_MODEL });
  await host.host.send("go", () => {});
  expect(host.chatBackends[0]?.toolProviders?.map((p) => p.id)).toContain("web");
  expect(host.nestedBackends[0]?.toolProviders).toEqual(host.resources.toolProviders);
  expect(host.nestedBackends[0]?.toolProviders?.map((p) => p.id)).not.toContain("web");
});

test("AC-14 exposed subagent Bash git push reaches parent's ask controller with guard reason", async () => {
  const decision = Promise.withResolvers<"allow" | "deny">();
  const rows: unknown[] = [];
  const host = setup({
    nestedAnswer: (_id, reply) => {
      if ("decision" in reply) decision.resolve(reply.decision);
      return "accepted";
    },
    nestedScript: async function* (backend) {
      const asked = Promise.withResolvers<AskRequest>();
      const runtime = createCodingToolRuntime({
        policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], host.host.repoRoot, {
          bashApproval: backend.bashApproval,
        }),
        extraTools: [
          {
            name: "Bash",
            description: "recording Bash",
            inputSchema: { type: "object" },
            scope: { pathFields: [] },
            run: async () => {
              throw new Error("denied push ran");
            },
          },
        ],
        webExposure: backend.hostPorts?.webExposure,
        askResolver: {
          resolve: async (req) => {
            asked.resolve(req);
            return { decision: await decision.promise, decidedBy: "human", latencyMs: 0 };
          },
        },
        sink: {
          record: (row) => {
            rows.push(row);
          },
          flush: async () => {},
        },
      });
      const calling = runtime.callTool("Bash", { command: "git push" });
      const request = await asked.promise;
      yield approvalRequestedEvent("web-push", request.reason ?? "", {
        tool: "Bash",
        command: "git push",
        ...(request.rule === "web-exposure" ? { webExposure: true } : {}),
      });
      expect((await calling).kind).toBe("denied");
    },
  });
  await host.host.start({ mode: "full", model: CHAT_MODEL });
  await fetchChatPage(web);
  const sending = host.host.send("go", () => {});
  await waitForCondition(() => host.nestedBackends.length > 0);
  const port = host.nestedBackends[0]?.hostPorts?.webExposure;
  assertDefined(port);
  expect(
    port.assess({
      tool: "Bash",
      input: { command: "git push" },
      root: host.host.repoRoot,
      resolvedPaths: [],
      sandboxed: true,
    })?.reason,
  ).toBe("git push after this session read web content");
  await waitForCondition(() => host.host.asks.pending().length > 0);
  expect(host.host.asks.pending()[0]).toMatchObject({
    reason: "[agent reviewer] git push after this session read web content",
  });
  host.host.asks.resolve("web-push", "deny");
  expect(host.nestedSessions[0]?.answers).toEqual([["web-push", { decision: "deny" }]]);
  await sending;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ outcome: "denied:ask" });
});
test.each(["raw", "gated"] as const)(
  "AC-15 %s exposed Bash reaches full-mode ask and refusal is ledgered once",
  async (bashApproval) => {
    const host = setup({ skipRun: true });
    await host.host.start({ mode: "full", model: CHAT_MODEL });
    await fetchChatPage(web);
    const port = host.chatBackends[0]?.hostPorts?.webExposure;
    assertDefined(port);
    const pending = Promise.withResolvers<"allow" | "deny">();
    const controller = createChatAskController({
      mode: "full",
      answer: (_id, reply) => {
        if ("decision" in reply) pending.resolve(reply.decision);
      },
    });
    const rows: unknown[] = [];
    let ran = false;
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], host.host.repoRoot, {
        bashApproval,
        ...(bashApproval === "gated" ? { askRules: [{ tool: "Bash", patterns: ["git push"] }] } : {}),
      }),
      extraTools: [
        {
          name: "Bash",
          description: "recording Bash",
          inputSchema: { type: "object" },
          scope: { pathFields: [] },
          run: async () => {
            ran = true;
            return { content: "ran" };
          },
        },
      ],
      webExposure: port,
      askResolver: {
        resolve: async (req) => {
          controller.handle(
            approvalRequestedEvent("push", req.reason ?? "", {
              tool: "Bash",
              command: "git push",
              ...(req.rule === "web-exposure" ? { webExposure: true } : {}),
            }),
          );
          return { decision: await pending.promise, decidedBy: "human", latencyMs: 0 };
        },
      },
      sink: {
        record: (row) => {
          rows.push(row);
        },
        flush: async () => {},
      },
    });
    const calling = runtime.callTool("Bash", { command: "git push" });
    await waitForCondition(() => controller.pending().length > 0);
    expect(controller.pending()[0]).toMatchObject({ reason: "git push after this session read web content" });
    controller.resolve("push", "deny");
    expect((await calling).kind).toBe("denied");
    expect(ran).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "denied:ask" });
  },
);
