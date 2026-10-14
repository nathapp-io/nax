import { describe, expect, test } from "bun:test";
import type {
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type {
  AgentSessionProfile,
  ApprovalDecidedBy,
  ApprovalRequest,
  SandboxPolicy,
  SessionAskPort,
} from "@nathapp/nax-agent";
import { OUTSIDE_WRITE_ROOTS_REASON } from "#src/client/edit-targets";
import {
  ASK_REASON,
  decidePermission,
  FULL_REASON,
  NO_ALLOW_ONCE_REASON,
  offeredOptions,
  REVIEW_NO_SANDBOX_REASON,
  readOnlyReason,
  rejectLocally,
  UNSHOWABLE_REASON,
} from "#src/client/permissions";

/** maskForPrompt refuses it: an assignment secret spans shell syntax. */
const UNMASKABLE = "TOKEN=abc;rm x";
const IDLE = new AbortController().signal;

function request(
  kinds: readonly PermissionOptionKind[],
  toolCall: RequestPermissionRequest["toolCall"] = { toolCallId: "t-1", kind: "edit", title: "Edit a.ts" },
): RequestPermissionRequest {
  return { sessionId: "s", toolCall, options: kinds.map((kind) => ({ optionId: `opt-${kind}`, name: kind, kind })) };
}

interface Recorded {
  readonly auto: { readonly req: Omit<ApprovalRequest, "command" | "signal">; readonly decision: string }[];
  readonly asked: ApprovalRequest[];
}

function asks(
  answer: () => Promise<{ decision: "allow" | "deny"; decidedBy: ApprovalDecidedBy }> = async () => ({
    decision: "allow",
    decidedBy: "human",
  }),
): { port: SessionAskPort; seen: Recorded } {
  const seen: Recorded = { auto: [], asked: [] };
  const port: SessionAskPort = {
    requestApproval: async (req) => {
      seen.asked.push(req);
      return answer();
    },
    recordAutoDecision: (req, decision) => {
      seen.auto.push({ req, decision });
    },
    askQuestion: async () => null,
    noteQuestion: () => {},
  };
  return { port, seen };
}

function ctx(profile: AgentSessionProfile, port: SessionAskPort, signal: AbortSignal = IDLE) {
  return { profile, asks: port, secrets: [], signal };
}

// Typed: bun's toEqual is typed against the actual value, and a widened `outcome: string` does not compile.
const selected = (kind: string): RequestPermissionResponse => ({
  outcome: { outcome: "selected", optionId: `opt-${kind}` },
});
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

describe("offeredOptions and rejectLocally", () => {
  test("only the *_once kinds are picked; the first of each wins", () => {
    const req = request(["allow_always", "allow_once", "reject_always", "reject_once"]);
    expect(offeredOptions(req)).toEqual({ allowOnce: "opt-allow_once", rejectOnce: "opt-reject_once" });
    expect(rejectLocally(req)).toEqual(selected("reject_once"));
  });

  test("persistent kinds alone offer nothing", () => {
    expect(offeredOptions(request(["allow_always", "reject_always"]))).toEqual({});
    expect(rejectLocally(request(["allow_always", "reject_always"]))).toEqual(CANCELLED);
  });

  test("malformed options are ignored, not thrown on", () => {
    const malformed: RequestPermissionRequest = JSON.parse(
      '{"sessionId":"s","toolCall":{"toolCallId":"t"},"options":[null,{"kind":"reject_once","optionId":7},{"kind":"allow_once","optionId":""}]}',
    );
    expect(offeredOptions(malformed)).toEqual({});
    const noList: RequestPermissionRequest = JSON.parse('{"sessionId":"s","toolCall":null,"options":null}');
    expect(rejectLocally(noList)).toEqual(CANCELLED);
  });
});

describe("decidePermission: an aborted signal (D3-d, spec §6.4 expiry)", () => {
  test.each(["none", "read", "ask", "full"] as const)("%s: cancelled, no event, nobody asked", async (profile) => {
    const { port, seen } = asks();
    const aborted = new AbortController();
    aborted.abort();
    expect(await decidePermission(request(["allow_once", "reject_once"]), ctx(profile, port, aborted.signal))).toEqual(
      CANCELLED,
    );
    expect(seen.auto).toEqual([]);
    expect(seen.asked).toEqual([]);
  });
});

describe("decidePermission: none and read (spec §6.4)", () => {
  test.each(["none", "read"] as const)("%s rejects with a profile decision", async (profile) => {
    const { port, seen } = asks();
    expect(await decidePermission(request(["allow_once", "reject_once"]), ctx(profile, port))).toEqual(
      selected("reject_once"),
    );
    expect(seen.asked).toEqual([]);
    expect(seen.auto).toEqual([
      {
        req: { callId: "t-1", tool: "edit", summary: "Edit a.ts", reason: readOnlyReason(profile) },
        decision: "deny",
      },
    ]);
  });

  test("read rejects Claude's request to leave plan mode (switch_mode)", async () => {
    const { port } = asks();
    const exitPlan = request(["allow_always", "allow_once", "reject_once"], {
      toolCallId: "t-2",
      kind: "switch_mode",
      title: "Ready to code?",
    });
    expect(await decidePermission(exitPlan, ctx("read", port))).toEqual(selected("reject_once"));
  });

  test("without reject_once: cancelled, still recorded as a deny", async () => {
    const { port, seen } = asks();
    expect(await decidePermission(request(["allow_once"]), ctx("none", port))).toEqual(CANCELLED);
    expect(seen.auto.map((a) => a.decision)).toEqual(["deny"]);
  });
});

describe("decidePermission: full", () => {
  test("allow_once with a profile decision; allow_always never chosen", async () => {
    const { port, seen } = asks();
    expect(await decidePermission(request(["allow_always", "allow_once", "reject_once"]), ctx("full", port))).toEqual(
      selected("allow_once"),
    );
    expect(seen.auto).toEqual([
      { req: { callId: "t-1", tool: "edit", summary: "Edit a.ts", reason: FULL_REASON }, decision: "allow" },
    ]);
  });

  test("no allow_once offered: denied with reject_once and the reason recorded", async () => {
    const { port, seen } = asks();
    expect(await decidePermission(request(["allow_always", "reject_once"]), ctx("full", port))).toEqual(
      selected("reject_once"),
    );
    expect(seen.auto[0]).toMatchObject({ req: { reason: NO_ALLOW_ONCE_REASON }, decision: "deny" });
  });
});

describe("decidePermission: ask", () => {
  test("the caller allows: allow_once; the request carries the display fields and the signal", async () => {
    const { port, seen } = asks();
    const signal = new AbortController().signal;
    const runTests = request(["allow_once", "reject_once"], {
      toolCallId: "t-3",
      kind: "execute",
      title: "Run tests",
      rawInput: { command: "bun test ./x" },
    });
    expect(await decidePermission(runTests, ctx("ask", port, signal))).toEqual(selected("allow_once"));
    expect(seen.asked).toEqual([
      {
        callId: "t-3",
        tool: "execute",
        summary: "Run tests",
        command: "bun test ./x",
        reason: ASK_REASON,
        signal,
      },
    ]);
    expect(seen.auto).toEqual([]);
  });

  test.each([
    ["human", selected("reject_once")],
    ["timeout", selected("reject_once")],
    ["cancelled", CANCELLED],
  ] as const)("a deny decided by %s answers %o", async (decidedBy, expected) => {
    const { port } = asks(async () => ({ decision: "deny", decidedBy }));
    expect(await decidePermission(request(["allow_once", "reject_once"]), ctx("ask", port))).toEqual(expected);
  });

  test("a throwing ask port (no-turn race) answers cancelled (D3-f)", async () => {
    const { port } = asks(async () => {
      throw new Error("no turn");
    });
    expect(await decidePermission(request(["allow_once", "reject_once"]), ctx("ask", port))).toEqual(CANCELLED);
  });

  test("no allow_once offered: denied without asking", async () => {
    const { port, seen } = asks();
    expect(await decidePermission(request(["reject_once"]), ctx("ask", port))).toEqual(selected("reject_once"));
    expect(seen.asked).toEqual([]);
    expect(seen.auto[0]).toMatchObject({ req: { reason: NO_ALLOW_ONCE_REASON }, decision: "deny" });
  });

  test("an unshowable request is denied without asking (D3-b)", async () => {
    const { port, seen } = asks();
    const unshowable = request(["allow_once", "reject_once"], {
      toolCallId: "t-4",
      kind: "execute",
      title: "Run",
      rawInput: { command: UNMASKABLE },
    });
    expect(await decidePermission(unshowable, ctx("ask", port))).toEqual(selected("reject_once"));
    expect(seen.asked).toEqual([]);
    expect(seen.auto[0]).toMatchObject({ req: { reason: UNSHOWABLE_REASON }, decision: "deny" });
  });
});

describe("profile review (nax#2500)", () => {
  const base = (sandbox?: SandboxPolicy) => ({
    profile: "review" as const,
    secrets: [],
    signal: IDLE,
    ...(sandbox ? { sandbox } : {}),
  });
  const OPEN: SandboxPolicy = { writeRoots: ["/r"], denyWrite: [], denyRead: [], network: {} };
  const LISTED: SandboxPolicy = { ...OPEN, network: { allowedDomains: ["pypi.org"] } };
  const net = { toolCallId: "n", kind: "other" as const, title: "SandboxNetworkAccess" };

  test("allows an execute request", async () => {
    const { port, seen } = asks();
    const res = await decidePermission(
      request(["allow_once", "reject_once"], { toolCallId: "t", kind: "execute", title: "ruff format --check ." }),
      { ...base(OPEN), asks: port },
    );
    expect(res).toEqual(selected("allow_once"));
    expect(seen.auto[0]?.decision).toBe("allow");
  });

  test("execute with no sandbox is denied (fail closed)", async () => {
    const { port, seen } = asks();
    const res = await decidePermission(
      request(["allow_once", "reject_once"], { toolCallId: "t", kind: "execute", title: "ls" }),
      { ...base(), asks: port },
    );
    expect(res).toEqual(selected("reject_once"));
    expect(seen.auto[0]?.req.reason).toBe(REVIEW_NO_SANDBOX_REASON);
    expect(seen.auto[0]?.decision).toBe("deny");
  });

  test("denies an edit request", async () => {
    const { port } = asks();
    const res = await decidePermission(request(["allow_once", "reject_once"]), { ...base(OPEN), asks: port });
    expect(res).toEqual(selected("reject_once"));
  });

  test("network request: allowed when the sandbox network is open, denied under an allow-list", async () => {
    const { port } = asks();
    expect(await decidePermission(request(["allow_once", "reject_once"], net), { ...base(OPEN), asks: port })).toEqual(
      selected("allow_once"),
    );
    expect(
      await decidePermission(request(["allow_once", "reject_once"], net), { ...base(LISTED), asks: port }),
    ).toEqual(selected("reject_once"));
  });

  test("an edit-kind request titled SandboxNetworkAccess is not a network request: denied read-only", async () => {
    const { port, seen } = asks();
    const res = await decidePermission(
      request(["allow_once", "reject_once"], { toolCallId: "n", kind: "edit", title: "SandboxNetworkAccess" }),
      { ...base(OPEN), asks: port },
    );
    expect(res).toEqual(selected("reject_once"));
    expect(seen.auto[0]?.req.reason).toBe(readOnlyReason("review"));
  });

  test("a network request with no kind still counts", async () => {
    const { port } = asks();
    const res = await decidePermission(
      request(["allow_once", "reject_once"], { toolCallId: "n", title: "SandboxNetworkAccess" }),
      { ...base(OPEN), asks: port },
    );
    expect(res).toEqual(selected("allow_once"));
  });

  test("full: network request follows the same rule", async () => {
    const { port } = asks();
    expect(
      await decidePermission(request(["allow_once", "reject_once"], net), {
        profile: "full",
        secrets: [],
        signal: IDLE,
        asks: port,
        sandbox: LISTED,
      }),
    ).toEqual(selected("reject_once"));
  });
});

describe("full: R4 edit path check (nax#2500)", () => {
  const ROOT = "/work/repo";
  const SANDBOX: SandboxPolicy = { writeRoots: [ROOT], denyWrite: [`${ROOT}/.git/hooks`], denyRead: [], network: {} };
  const edit = (toolCall: Record<string, unknown>) =>
    request(["allow_once", "reject_once"], { toolCallId: "e", kind: "edit", title: "Edit", ...toolCall });
  const fullCtx = (port: SessionAskPort, extra: { sandbox?: SandboxPolicy; cwd?: string } = {}) => ({
    profile: "full" as const,
    secrets: [],
    signal: IDLE,
    asks: port,
    ...extra,
  });

  test("an edit outside the write roots is rejected with the outside-roots reason", async () => {
    const { port, seen } = asks();
    const res = await decidePermission(
      edit({ locations: [{ path: "/etc/x" }] }),
      fullCtx(port, { sandbox: SANDBOX, cwd: ROOT }),
    );
    expect(res).toEqual(selected("reject_once"));
    expect(seen.auto[0]?.req.reason).toBe(OUTSIDE_WRITE_ROOTS_REASON);
    expect(seen.auto[0]?.decision).toBe("deny");
  });

  test("a read outside the write roots is allowed under full (R5/R8: read-only kinds are exempt)", async () => {
    const { port } = asks();
    expect(
      await decidePermission(
        edit({ kind: "read", locations: [{ path: "/etc/x" }] }),
        fullCtx(port, { sandbox: SANDBOX, cwd: ROOT }),
      ),
    ).toEqual(selected("allow_once"));
  });

  test("an other-kind request outside the write roots is rejected (R8: unknown kinds fail closed)", async () => {
    const { port, seen } = asks();
    const res = await decidePermission(
      edit({ kind: "other", locations: [{ path: "/etc/x" }] }),
      fullCtx(port, { sandbox: SANDBOX, cwd: ROOT }),
    );
    expect(res).toEqual(selected("reject_once"));
    expect(seen.auto[0]?.req.reason).toBe(OUTSIDE_WRITE_ROOTS_REASON);
  });

  test("an execute request with a path outside the write roots is still allowed under full (R8)", async () => {
    const { port } = asks();
    expect(
      await decidePermission(
        request(["allow_once", "reject_once"], {
          toolCallId: "x",
          kind: "execute",
          title: "cat /etc/x",
          locations: [{ path: "/etc/x" }],
        }),
        fullCtx(port, { sandbox: SANDBOX, cwd: ROOT }),
      ),
    ).toEqual(selected("allow_once"));
  });

  test("a delete outside the write roots is rejected (R5)", async () => {
    const { port, seen } = asks();
    const res = await decidePermission(
      edit({ kind: "delete", locations: [{ path: "/etc/x" }] }),
      fullCtx(port, { sandbox: SANDBOX, cwd: ROOT }),
    );
    expect(res).toEqual(selected("reject_once"));
    expect(seen.auto[0]?.req.reason).toBe(OUTSIDE_WRITE_ROOTS_REASON);
  });

  test("an edit under denyWrite is rejected", async () => {
    const { port } = asks();
    const res = await decidePermission(
      edit({ rawInput: { file_path: `${ROOT}/.git/hooks/pre-commit` } }),
      fullCtx(port, { sandbox: SANDBOX, cwd: ROOT }),
    );
    expect(res).toEqual(selected("reject_once"));
  });

  test("an edit inside the root is allowed", async () => {
    const { port, seen } = asks();
    const res = await decidePermission(
      edit({ locations: [{ path: `${ROOT}/src/a.ts` }] }),
      fullCtx(port, { sandbox: SANDBOX, cwd: ROOT }),
    );
    expect(res).toEqual(selected("allow_once"));
    expect(seen.auto[0]?.req.reason).toBe(FULL_REASON);
  });

  test("an edit with no path is allowed (today's behaviour)", async () => {
    const { port } = asks();
    expect(await decidePermission(edit({}), fullCtx(port, { sandbox: SANDBOX, cwd: ROOT }))).toEqual(
      selected("allow_once"),
    );
  });

  test("full with no sandbox in ctx: an outside edit is allowed", async () => {
    const { port } = asks();
    expect(await decidePermission(edit({ locations: [{ path: "/etc/x" }] }), fullCtx(port))).toEqual(
      selected("allow_once"),
    );
  });

  test("an execute request under full with a policy is allowed (Bash is the sandbox's job)", async () => {
    const { port } = asks();
    const res = await decidePermission(
      request(["allow_once", "reject_once"], { toolCallId: "x", kind: "execute", title: "rm -rf /etc/x" }),
      fullCtx(port, { sandbox: SANDBOX, cwd: ROOT }),
    );
    expect(res).toEqual(selected("allow_once"));
  });

  test("an outside edit with no allow_once offered is denied with no allow option", async () => {
    const { port } = asks();
    const res = await decidePermission(
      request(["reject_once"], { toolCallId: "e", kind: "edit", title: "Edit", locations: [{ path: "/etc/x" }] }),
      fullCtx(port, { sandbox: SANDBOX, cwd: ROOT }),
    );
    expect(res).toEqual(selected("reject_once"));
  });
});
