// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import type { OpenSessionOpts, SendTurnOpts } from "@/agents/session-types";

/**
 * Type-level pins. The native adapter cannot resolve a transcript directory or
 * a tool catalogue on its own — SessionManager supplies both — and a silent
 * removal of either field would leave the native path quietly toolless.
 */
describe("session opts carry what the native adapter needs", () => {
  test("OpenSessionOpts accepts a transcriptDir", () => {
    const opts: Pick<OpenSessionOpts, "transcriptDir"> = { transcriptDir: "/tmp/x" };
    expect(opts.transcriptDir).toBe("/tmp/x");
  });

  test("SendTurnOpts accepts contextPullTools", () => {
    const opts: Pick<SendTurnOpts, "contextPullTools"> = {
      contextPullTools: [
        {
          name: "query_neighbor",
          description: "d",
          inputSchema: { type: "object" },
          maxCallsPerSession: 5,
          maxTokensPerCall: 100,
        },
      ],
    };
    expect(opts.contextPullTools?.[0]?.name).toBe("query_neighbor");
  });
});
