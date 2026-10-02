/**
 * US-006 — the dispatch-event builders forward the credential identity
 * (`auth`) the adapter stamped on its result, and omit the key entirely when
 * there is none.
 *
 * `buildCompleteEvent` takes the stamp as an explicit input (the manager threads
 * it off `CompleteResult` via `completeResultProvenance`); `buildSessionTurnEvent`
 * reads it off the `TurnResult` it is already given. Absence is asserted with
 * `in` rather than `toBeUndefined()` so an implementer cannot satisfy the test by
 * writing `auth: undefined` — ACP rows and pre-US-006 producers must stay
 * byte-identical, which is what "the key is not there" means.
 *
 * Acceptance criteria covered: AC6, AC7, AC8.
 */

import { describe, expect, test } from "bun:test";
import type { AuthStamp, SessionHandle } from "@nathapp/nax-agent";
import { makeTurnResult } from "@test/helpers";
import { buildCompleteEvent, buildSessionTurnEvent } from "@/agents/manager-dispatch";
import type { TurnResult } from "@/agents/types";
import { DEFAULT_CONFIG } from "@/config";
import { resolvePermissions } from "@/config/permissions";

const PERMS = resolvePermissions(DEFAULT_CONFIG, "run");

const STAMP: AuthStamp = { fingerprint: "0123456789ab", source: "file" };

const HANDLE: SessionHandle = { id: "nax-us006-session", agentName: "claude" };

type CompleteEventInput = Parameters<typeof buildCompleteEvent>[0];

function completeInput(over: Partial<CompleteEventInput> = {}): CompleteEventInput {
  return {
    sessionName: "nax-us006-complete-s1",
    prompt: "plan this",
    response: "planned",
    agentName: "claude",
    stage: "complete",
    options: { modelDef: { provider: "anthropic", model: "claude-haiku" }, workdir: "/tmp/us006" },
    resolvedPermissions: PERMS,
    tokenUsage: { inputTokens: 10, outputTokens: 5 },
    startedAt: 1_000,
    ...over,
  };
}

function sessionTurnInput(result: TurnResult): Parameters<typeof buildSessionTurnEvent>[0] {
  return {
    handle: HANDLE,
    sessionRole: "main",
    prompt: "do the thing",
    result,
    agentName: "claude",
    stage: "run",
    opts: { pipelineStage: "run", storyId: "US-006" },
    resolvedPermissions: PERMS,
    startedAt: 1_000,
  };
}

describe("buildCompleteEvent — auth forwarding (US-006)", () => {
  // AC6 (success): the stamp the manager read off CompleteResult reaches the
  // event unchanged.
  test("AC6: given auth, returns an event whose auth equals the input", () => {
    const event = buildCompleteEvent(completeInput({ auth: STAMP }));

    expect(event.auth).toEqual(STAMP);
  });

  // AC7 (boundary): a producer that stamped no credential (every ACP one-shot)
  // must leave the key off the event rather than carrying `undefined`.
  test("AC7: given no auth, returns an event with no auth key", () => {
    const event = buildCompleteEvent(completeInput());

    expect("auth" in event).toBe(false);
  });
});

describe("buildSessionTurnEvent — auth forwarding (US-006)", () => {
  // AC8 (success): the stamp rides on the TurnResult the adapter returned, and
  // the builder reads it there — the event carries it.
  test("AC8: given a TurnResult carrying auth, returns an event whose auth equals it", () => {
    const event = buildSessionTurnEvent(sessionTurnInput(makeTurnResult({ auth: STAMP })));

    expect(event.auth).toEqual(STAMP);
  });

  // AC8 boundary: a TurnResult with no stamp (ACP turns) leaves the key off the
  // event, so a reader can tell "no report" apart from "reported as undefined".
  test("AC8 boundary: given a TurnResult with no auth, returns an event with no auth key", () => {
    const event = buildSessionTurnEvent(sessionTurnInput(makeTurnResult()));

    expect("auth" in event).toBe(false);
  });
});
