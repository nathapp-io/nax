import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { _fixReportDeps, replyStep } from "@/bot/fix-report";
import { withNaxBotMarker } from "@/forge";

afterEach(() => mock.restore());

describe("resolveOwnFindings via replyStep", () => {
  test("AC-19 never replies to or resolves an agreed workflow finding", async () => {
    const key = "w-B3.12345678";
    const base = makeBotFixEnv([{ kind: "finding", key, issue: "hold", severity: "minor" }]);
    const env = {
      ...base,
      threads: [
        {
          id: "1",
          replyTo: "1",
          resolved: false,
          outdated: false,
          comments: [
            {
              id: "7",
              kind: "thread" as const,
              author: base.user.login,
              body: withNaxBotMarker("finding", key),
              createdAt: "",
            },
          ],
        },
      ],
    };
    const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    expect((await replyStep(env, { step: "reply", timings: {}, pushedSha: "abcdef12" })).patch).toEqual({
      replied: 0,
      resolved: 0,
    });
    expect(reply).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});
