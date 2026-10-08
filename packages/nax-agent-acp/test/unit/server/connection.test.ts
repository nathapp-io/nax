import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { client, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { initializeResponse } from "#src/server/capabilities";
import { buildAgentApp, serveStdio } from "#src/server/connection";

describe("initialize (S5-0 capabilities)", () => {
  test("advertises only what S5-0 implements", () => {
    expect(initializeResponse("1.2.3")).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      authMethods: [],
      agentInfo: { name: "nax-agent", title: "nax-agent", version: "1.2.3" },
    });
  });

  test("an in-process client gets the response; a session method is not found yet", async () => {
    const result = await client({ name: "test" }).connectWith(buildAgentApp({ version: "9.9.9" }), async (agent) => {
      const init = await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
      const failure = await agent.request("session/new", { cwd: "/tmp", mcpServers: [] }).catch((e: unknown) => e);
      return { init, failure };
    });
    expect(result.init.agentInfo?.version).toBe("9.9.9");
    expect(result.failure).toBeInstanceOf(RequestError);
    expect(result.failure instanceof RequestError ? result.failure.code : 0).toBe(-32601);
  });
});

describe("serveStdio", () => {
  test("answers an initialize frame on stdout and closes when stdin ends", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const connection = serveStdio(buildAgentApp({ version: "9.9.9" }), { stdin, stdout });
    const line = new Promise<string>((resolve) =>
      stdout.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8"))),
    );
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    const frame = JSON.parse((await line).trim());
    expect(frame).toMatchObject({ jsonrpc: "2.0", id: 1, result: { agentInfo: { name: "nax-agent" } } });
    stdin.end();
    connection.close();
    await connection.closed;
  });
});
