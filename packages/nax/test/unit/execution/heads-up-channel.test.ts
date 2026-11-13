/**
 * `headsUpChannel` — the one integration seam the cut retained.
 *
 * The uncategorised-failure caller that used to share this module went with the
 * post-run inspection layer (US-003). `headsUpChannel` stayed because
 * `src/workflow/stage-env.ts` still spreads it into `createAdvisor`, so these are
 * its regression guards: the seam must survive on the `@/execution` barrel, and
 * it must stay inert — resolving, never throwing — on a run with no interaction
 * chain (the workflow story loop runs headless far more often than not).
 */

import { describe, expect, mock, test } from "bun:test";
import { assertDefined, firstCall, makeInteractionChain, makeTestContext } from "@test/helpers";
import { headsUpChannel } from "@/execution";
import type { InteractionRequest } from "@/interaction/types";

describe("headsUpChannel", () => {
  test("returns a channel whose headsUp is a function when there is no interaction chain", () => {
    const ctx = makeTestContext({ interaction: undefined });

    const channel = headsUpChannel(ctx);

    expect(ctx.interaction).toBeUndefined();
    expect(typeof channel.headsUp).toBe("function");
  });

  test("headsUp resolves to no-interaction-channel instead of throwing when interaction is absent", async () => {
    const ctx = makeTestContext({ interaction: undefined });
    const { headsUp } = headsUpChannel(ctx);
    assertDefined(headsUp, "headsUp");

    const result = await headsUp("inspection required");

    expect(result).toEqual({ sent: false, reason: "no-interaction-channel" });
  });

  test("headsUp delivers a notify request through the chain and reports sent", async () => {
    const send = mock(async (_request: InteractionRequest) => undefined);
    const ctx = makeTestContext({ interaction: makeInteractionChain({ send }) });
    const { headsUp } = headsUpChannel(ctx);
    assertDefined(headsUp, "headsUp");

    const result = await headsUp("inspection required");

    expect(result).toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
    const [request] = firstCall(send, "interaction.send");
    expect(request.type).toBe("notify");
    expect(request.storyId).toBe("US-001");
    expect(request.detail).toBe("inspection required");
    expect(request.summary).toContain("US-001");
  });
});
