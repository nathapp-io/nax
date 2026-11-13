/**
 * flow-provider.ts — the `nax-flow__send` tool and its card.
 *
 * Every collaborator is behind `_flowProviderDeps`, so each arm of the run is
 * driven here without a repository on disk, a remote, or a koda server.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, withDepsRestore } from "@test/helpers";
import type { HostApprovalCard } from "@/chat/ask-controller";
import {
  _flowProviderDeps,
  checkFlowBranch,
  createFlowProvider,
  FLOW_PUSH_COMMIT_MESSAGE,
  FLOW_SEND_INPUT_SCHEMA,
  type FlowCreateBody,
  type FlowCreateOutcome,
  type FlowProviderOptions,
  type FlowRepoReady,
  type KodaFlowConnection,
} from "@/chat/flow";
import { NaxError } from "@/errors";
import { buildFlowInstructions } from "@/prompts";

withDepsRestore(_flowProviderDeps, [
  "readFlowRepoState",
  "readFlowPushUrl",
  "headSha",
  "isDirty",
  "commitAndPush",
  "createKodaFlow",
]);

const REPO_ROOT = "/fixture/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const SPEC_A = ".nax/features/a/spec.md";
const SPEC_B = ".nax/features/b/spec.md";
/** The push destination, as a repository with an SSH `origin` resolves it. */
const PUSH_URL = "git@github.com:o/r.git";

const connection: KodaFlowConnection = {
  url: "https://koda.example/api",
  headers: { Authorization: "Bearer k" },
};

/** The request the brief uses: feature `a`, then `b` which waits for `a`. */
const input = {
  features: [
    { feature: "a", specPath: SPEC_A },
    { feature: "b", specPath: SPEC_B, dependsOn: ["a"] },
  ],
  roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
  costCapUsd: 5,
};

interface PushCall {
  readonly repoRoot: string;
  readonly branch: string;
  readonly message: string;
  readonly opts: unknown;
}

interface KodaCall {
  readonly connection: KodaFlowConnection;
  readonly body: FlowCreateBody;
}

let approveCalls: HostApprovalCard[];
/** What the host answers the card with; a test replaces it to deny, reject or abort. */
let reply: (card: HostApprovalCard) => Promise<"allow" | "deny">;
let pushCalls: PushCall[];
let kodaCalls: KodaCall[];
/** The order side effects ran in, so "before" is assertable. */
let sequence: string[];
let options: FlowProviderOptions;

/** A repository state a flow may be sent from. */
function ready(branch = "feat/x", sha = SHA, remoteUrl = "https://github.com/o/r"): FlowRepoReady {
  return { ok: true, branch, sha, remoteUrl };
}

/** The tool's run context; `signal` is the turn's cancellation. */
function context(signal?: AbortSignal) {
  return {
    root: REPO_ROOT,
    resolvedPaths: [],
    maxBytes: 300_000,
    maxFileBytes: 300_000,
    ...(signal ? { signal } : {}),
  };
}

/** Run the provider's `send` tool with `request`. */
async function send(request: Record<string, unknown>, signal?: AbortSignal) {
  const tool = (await createFlowProvider(options).tools(REPO_ROOT))[0];
  if (tool === undefined) throw new Error("the nax-flow provider exposes no tools");
  return tool.run(request, context(signal));
}

beforeEach(() => {
  approveCalls = [];
  pushCalls = [];
  kodaCalls = [];
  sequence = [];
  reply = async () => "allow";
  _flowProviderDeps.readFlowRepoState = async () => ready();
  _flowProviderDeps.readFlowPushUrl = async () => ({ ok: true, url: PUSH_URL });
  _flowProviderDeps.headSha = async () => SHA;
  _flowProviderDeps.isDirty = async () => false;
  _flowProviderDeps.commitAndPush = async (repoRoot, branch, message, opts) => {
    pushCalls.push({ repoRoot, branch, message, opts });
    sequence.push("push");
    return { committed: false, pushed: true };
  };
  _flowProviderDeps.createKodaFlow = async (sentConnection, body) => {
    kodaCalls.push({ connection: sentConnection, body });
    sequence.push("koda");
    return { kind: "created", id: "f1", state: "PENDING", url: "/sandbox/flows/f1" };
  };
  options = {
    repoRoot: REPO_ROOT,
    connection,
    approve: async (card) => {
      approveCalls.push(card);
      sequence.push("approve");
      return await reply(card);
    },
  };
});

describe("createFlowProvider", () => {
  test("is the static nax-flow provider (AC-1)", () => {
    const provider = createFlowProvider(options);

    expect(provider.id).toBe("nax-flow");
    expect(provider.kind).toBe("static");
    expect(provider.stages).toEqual(["*"]);
  });

  test("exposes exactly one tool, locally named send (AC-1)", async () => {
    const tools = await createFlowProvider(options).tools(REPO_ROOT);

    expect(tools.map((tool) => tool.localName)).toEqual(["send"]);
  });

  test("declares the request schema with no extra keys and three required fields (AC-1)", async () => {
    const tool = (await createFlowProvider(options).tools(REPO_ROOT))[0];
    if (tool === undefined) throw new Error("the nax-flow provider exposes no tools");

    expect(tool.inputSchema).toBe(FLOW_SEND_INPUT_SCHEMA);
    expect(FLOW_SEND_INPUT_SCHEMA.additionalProperties).toBe(false);
    expect(FLOW_SEND_INPUT_SCHEMA.required).toEqual(["features", "roles", "costCapUsd"]);
    expect(FLOW_SEND_INPUT_SCHEMA.properties.features.type).toBe("array");
    expect(FLOW_SEND_INPUT_SCHEMA.properties.roles.type).toBe("object");
    expect(FLOW_SEND_INPUT_SCHEMA.properties.costCapUsd.type).toBe("number");
  });

  test("describes the cost cap's decimal limit, not only its range (M1)", () => {
    // The brief asks the schema to describe the input constraints, and the runtime
    // rejects a fifth decimal from `String(value)`, which the range alone does not say.
    const description = FLOW_SEND_INPUT_SCHEMA.properties.costCapUsd.description;

    expect(description).toContain("greater than 0");
    expect(description).toContain("at most 1000");
    expect(description).toContain("at most 4 decimal places");
    expect(description).toContain("not a numeric string");
  });

  test("takes its instructions from buildFlowInstructions (AC-2)", async () => {
    const instructions = await createFlowProvider(options).instructions?.(REPO_ROOT);

    expect(instructions).toBe(buildFlowInstructions());
  });
});

describe("send — before the card", () => {
  test("lists every parse error and asks nothing when the request is invalid (AC-4)", async () => {
    const result = await send({ features: [], roles: {}, costCapUsd: 5 });

    expect(result.isError).toBe(true);
    expect(result.content.startsWith("[chat] ")).toBe(true);
    expect(result.content).toContain("features must list at least one feature");
    expect(result.content).toContain("roles.reviewer");
    expect(result.content).toContain("roles.supervisor");
    expect(approveCalls).toHaveLength(0);
    expect(sequence).toEqual([]);
  });

  test("names an unknown key and asks nothing (AC-4)", async () => {
    const result = await send({ ...input, extra: true });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('"extra"');
    expect(approveCalls).toHaveLength(0);
  });

  test("returns the repository failure message and asks nothing (AC-5)", async () => {
    const message = "[chat] commit or stash your changes before sending a flow";
    _flowProviderDeps.readFlowRepoState = async () => ({ ok: false, message });

    const result = await send(input);

    expect(result).toEqual({ isError: true, content: message });
    expect(approveCalls).toHaveLength(0);
    expect(sequence).toEqual([]);
  });

  test("returns the branch-rule message and asks nothing (AC-6)", async () => {
    const features = [
      { feature: "x", specPath: SPEC_A },
      { feature: "y", specPath: SPEC_B, dependsOn: ["x"] },
    ];
    _flowProviderDeps.readFlowRepoState = async () => ready("feat/y");
    const expected = checkFlowBranch("feat/y", features);
    assertDefined(expected, "the feat/y collision message");

    const result = await send({ ...input, features });

    expect(result).toEqual({ isError: true, content: expected });
    expect(result.content).toContain("feat/y");
    expect(approveCalls).toHaveLength(0);
  });
});

describe("send — the card", () => {
  test("asks once, naming the tool, the feature count and the push (AC-7)", async () => {
    await send(input);

    expect(approveCalls).toHaveLength(1);
    const card = approveCalls[0];
    assertDefined(card, "the approval card");
    expect(card.tool).toBe("nax-flow__send");
    expect(card.summary).toBe("send a flow of 2 feature(s) to koda");
    expect(card.command).toBe("git push --set-upstream origin feat/x");
  });

  test("states the repository, the features, the roles, the cap and koda's own approval (AC-8)", async () => {
    await send(input);

    const card = approveCalls[0];
    assertDefined(card, "the approval card");
    expect(card.reason).toBe(
      [
        "repo https://github.com/o/r on branch feat/x at 01234567",
        `1. a (${SPEC_A})`,
        `2. b (${SPEC_B}) — after: a`,
        "reviewer acp:codex, supervisor acp:claude",
        "cost cap $5.00",
        "koda will ask you to approve this flow before anything billed starts",
      ].join("\n"),
    );
  });

  test("carries the tool run's own abort signal (AC-9)", async () => {
    const controller = new AbortController();

    await send(input, controller.signal);

    const card = approveCalls[0];
    assertDefined(card, "the approval card");
    expect(card.signal).toBe(controller.signal);
  });
});

describe("send — after the card", () => {
  const DECLINED =
    "[chat] the user declined sending the flow to koda; do not retry with different arguments unless the user asks";
  const BRANCH_CHANGED = "[chat] the branch changed while the card was open; nothing was pushed";
  const PUSH_TARGET_MOVED =
    "[chat] the branch or origin being pushed changed while the card was open; nothing was pushed";

  test("stops with the cancelled result when the turn is aborted after allow (AC-10)", async () => {
    const controller = new AbortController();
    reply = async () => {
      controller.abort();
      return "allow";
    };

    const result = await send(input, controller.signal);

    expect(result).toEqual({ isError: true, content: "[chat] the turn was cancelled; nothing was pushed" });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
  });

  test("stops when the turn is cancelled during the pre-push reads (AC-10, B3)", async () => {
    // The reads between the card and the push are asynchronous, so a cancelled turn
    // can reach the push boundary after the one check at the top of afterAllow.
    const controller = new AbortController();
    _flowProviderDeps.readFlowPushUrl = async () => {
      controller.abort();
      return { ok: true, url: PUSH_URL };
    };

    const result = await send(input, controller.signal);

    expect(result).toEqual({ isError: true, content: "[chat] the turn was cancelled; nothing was pushed" });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
  });

  test("reports a rejecting approve as a failed send, without pushing (AC-11)", async () => {
    reply = async () => {
      throw new Error("the host has no card reader");
    };

    const result = await send(input);

    expect(result.isError).toBe(true);
    expect(result.content.startsWith("[chat] flow send failed: ")).toBe(true);
    expect(result.content).toContain("the host has no card reader");
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
  });

  test("returns the declined result and touches neither git nor koda (AC-12)", async () => {
    reply = async () => "deny";

    const result = await send(input);

    expect(result).toEqual({ isError: true, content: DECLINED });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
  });

  test("stops when the head moved while the card was open (AC-13)", async () => {
    _flowProviderDeps.headSha = async () => OTHER_SHA;

    const result = await send(input);

    expect(result).toEqual({ isError: true, content: BRANCH_CHANGED });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
  });

  test("stops when the tree became dirty while the card was open (AC-14)", async () => {
    _flowProviderDeps.isDirty = async () => true;

    const result = await send(input);

    expect(result).toEqual({ isError: true, content: BRANCH_CHANGED });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
  });

  test("stops before pushing when the checked-out branch changed at the same commit (F1)", async () => {
    // The card was shown for feat/x; by the push boundary the repository is on
    // another branch that happens to hold the same commit.
    const states = [ready(), ready("feat/other")];
    _flowProviderDeps.readFlowRepoState = async () => states.shift() ?? ready("feat/other");

    const result = await send(input);

    expect(result).toEqual({ isError: true, content: PUSH_TARGET_MOVED });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
  });

  test("stops before pushing when origin changed at the same commit (F1)", async () => {
    const states = [ready(), ready("feat/x", SHA, "https://github.com/other/fork")];
    _flowProviderDeps.readFlowRepoState = async () => states.shift() ?? ready();

    const result = await send(input);

    expect(result).toEqual({ isError: true, content: PUSH_TARGET_MOVED });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
  });

  test("pushes the branch with skipCommit before it calls koda (AC-15)", async () => {
    expect(FLOW_PUSH_COMMIT_MESSAGE).toBe("chore: send flow to koda");

    await send(input);

    // The push is bound to the carded commit and to the resolved push destination,
    // so neither the branch tip nor a repointed `origin` can decide what is pushed
    // or where it goes (F1).
    expect(pushCalls).toEqual([
      {
        repoRoot: REPO_ROOT,
        branch: "feat/x",
        message: FLOW_PUSH_COMMIT_MESSAGE,
        opts: { skipCommit: true, sourceSha: SHA, remote: PUSH_URL },
      },
    ]);
    expect(sequence).toEqual(["approve", "push", "koda"]);
  });

  test("pushes to the remote's push URL, keeping the transport it was configured with (F1)", async () => {
    const credential = "https://x-access-token:tok@github.com/o/r.git";
    _flowProviderDeps.readFlowPushUrl = async () => ({ ok: true, url: credential });

    await send(input);

    // A push URL carrying a credential still targets the carded repository, and it
    // is the credential-bearing URL that is used, so authentication keeps working.
    expect(pushCalls[0]?.opts).toEqual({ skipCommit: true, sourceSha: SHA, remote: credential });
    expect(kodaCalls).toHaveLength(1);
  });

  test.each([
    "http://user:token@github.com/o/r.git",
    "HTTP://user:token@github.com/o/r.git",
    "http://github.com/o/r.git",
  ])("rejects unencrypted push destination %s (F4)", async (url) => {
    _flowProviderDeps.readFlowPushUrl = async () => ({ ok: true, url });

    const result = await send(input);

    expect(result).toEqual({ isError: true, content: PUSH_TARGET_MOVED });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
    expect(result.content).not.toContain("token");
  });

  test("stops before pushing when the push destination is another repository (F1)", async () => {
    _flowProviderDeps.readFlowPushUrl = async () => ({ ok: true, url: "git@github.com:someone/else.git" });

    const result = await send(input);

    expect(result).toEqual({ isError: true, content: PUSH_TARGET_MOVED });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
  });

  test("stops when the push destination cannot be read (F1)", async () => {
    const message = "[chat] could not read the push destination of the origin remote";
    _flowProviderDeps.readFlowPushUrl = async () => ({ ok: false, message });

    const result = await send(input);

    expect(result).toEqual({ isError: true, content: message });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
  });

  test("carries the push failure and never calls koda (AC-16)", async () => {
    _flowProviderDeps.commitAndPush = async () => {
      throw new Error('git push of "feat/x" failed: origin refused the update');
    };

    const result = await send(input);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("origin refused the update");
    expect(kodaCalls).toHaveLength(0);
  });

  test("posts the connection and the whole body, with the carded sha (AC-17)", async () => {
    await send(input);

    expect(kodaCalls).toEqual([
      {
        connection,
        body: {
          remoteUrl: "https://github.com/o/r",
          branch: "feat/x",
          specSha: SHA,
          features: [
            { feature: "a", specPath: SPEC_A, dependsOn: [] },
            { feature: "b", specPath: SPEC_B, dependsOn: ["a"] },
          ],
          roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
          costCapUsd: 5,
        },
      },
    ]);
  });

  test("prints the created flow with its web link on the first line (AC-18)", async () => {
    const result = await send(input);

    expect(result.isError).toBeUndefined();
    expect(result.content.split("\n")[0]).toBe(
      '{"flow":"f1","state":"PENDING","url":"https://koda.example/sandbox/flows/f1"}',
    );
  });

  test("adds koda's own approval as the second line (AC-19)", async () => {
    const result = await send(input);

    expect(result.content.split("\n")[1]).toBe("koda will ask you to approve this flow before anything billed starts.");
  });

  test("reports a held create as the approval request holding it (AC-20)", async () => {
    _flowProviderDeps.createKodaFlow = async (): Promise<FlowCreateOutcome> => ({ kind: "held", requestId: "r1" });

    const result = await send(input);

    expect(result.content).toBe(
      "koda is holding the flow create for approval (request r1); no flow exists until it is approved, and " +
        "pushing new commits to the branch before then makes koda refuse it.",
    );
  });

  test("reports a non-2xx answer with koda's message and the pushed branch (AC-21)", async () => {
    _flowProviderDeps.createKodaFlow = async () => {
      throw new NaxError("[memory] koda POST /fleet/flows answered 404: repo not found", "MEMORY_KODA_HTTP", {
        stage: "memory",
        status: 404,
      });
    };

    const result = await send(input);

    expect(result).toEqual({
      isError: true,
      content: "[chat] koda did not create the flow (HTTP 404): repo not found; branch feat/x stays pushed",
    });
  });

  test.each(["FLOW_KODA_UNEXPECTED_RESPONSE", "MEMORY_KODA_BAD_RESPONSE"])(
    "reports %s as an unexpected answer (AC-22)",
    async (code) => {
      _flowProviderDeps.createKodaFlow = async () => {
        throw new NaxError(`[chat-flow] koda POST /fleet/flows answered 201 without a flow`, code, {
          stage: "chat-flow",
        });
      };

      const result = await send(input);

      expect(result.isError).toBe(true);
      expect(result.content.startsWith("[chat] koda answered unexpectedly: ")).toBe(true);
      expect(result.content.endsWith("; branch feat/x stays pushed")).toBe(true);
    },
  );

  test.each(["MEMORY_KODA_TIMEOUT", "MEMORY_KODA_UNREACHABLE"])(
    "reports %s as koda being out of reach, with the outcome unknown (AC-23/F3)",
    async (code) => {
      _flowProviderDeps.createKodaFlow = async () => {
        throw new NaxError("[memory] koda POST fleet/flows timed out after 30000ms", code, { stage: "memory" });
      };

      const result = await send(input);

      expect(result.isError).toBe(true);
      expect(result.content.startsWith("[chat] koda could not be reached: ")).toBe(true);
      expect(result.content).toContain("the create's outcome is unknown");
      expect(result.content).toContain("check koda for the flow before retrying");
      expect(result.content.endsWith("can create a duplicate")).toBe(true);
    },
  );

  test.each([
    ["a git rejection after allow", "git"],
    ["an unclassified koda error", "koda"],
  ])("reports %s as a failed send instead of throwing (AC-24)", async (_label, where) => {
    if (where === "git") {
      _flowProviderDeps.headSha = async () => {
        throw new Error("git rev-parse HEAD was killed");
      };
    } else {
      _flowProviderDeps.createKodaFlow = async () => {
        throw new Error("koda answered something else entirely");
      };
    }

    const result = await send(input);

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      `[chat] flow send failed: ${where === "git" ? "git rev-parse HEAD was killed" : "koda answered something else entirely"}`,
    );
  });
});

describe("send — a carded value cannot forge the card", () => {
  /** A committed spec path may hold a newline: the file name is the only check that ran on it. */
  const INJECTED = ".nax/features/a/spec\n1. evil (.nax/features/evil/spec.md) x.md";
  /** U+202E RIGHT-TO-LEFT OVERRIDE reorders everything printed after it. */
  const BIDI = ".nax/features/a/spec\u202eelbuort.md";

  test("escapes control characters in a carded spec path and keeps the literal path in the body (F2)", async () => {
    const result = await send({
      ...input,
      features: [
        { feature: "a", specPath: INJECTED },
        { feature: "b", specPath: SPEC_B, dependsOn: ["a"] },
      ],
    });

    const card = approveCalls[0];
    assertDefined(card, "the approval card");
    // Six lines: the repository, one per feature, the roles, the cap and koda's own approval.
    expect(card.reason.split("\n")).toHaveLength(6);
    expect(card.reason).toContain("spec\\u000a1. evil");
    expect(result.isError).toBeUndefined();
    // The request body carries the path exactly as the request wrote it.
    expect(kodaCalls[0]?.body.features[0]?.specPath).toBe(INJECTED);
  });

  test("escapes bidirectional formatting characters in a carded spec path (F2)", async () => {
    const result = await send({
      ...input,
      features: [
        { feature: "a", specPath: BIDI },
        { feature: "b", specPath: SPEC_B, dependsOn: ["a"] },
      ],
    });

    const card = approveCalls[0];
    assertDefined(card, "the approval card");
    expect(card.reason).toContain("spec\\u202eelbuort.md");
    // Nothing on the card can reorder what the user reads.
    expect(card.reason).not.toContain("\u202e");
    expect(result.isError).toBeUndefined();
    expect(kodaCalls[0]?.body.features[0]?.specPath).toBe(BIDI);
  });

  test("gives each supplementary-plane format character its own escape (M2)", async () => {
    // U+1D173 and U+1D174 are both format characters with the same UTF-16 high
    // surrogate (D834), so escaping the first code unit alone rendered them
    // identically — two distinct paths a user could not tell apart on the card.
    const withFormat = (mark: string) => ({
      ...input,
      features: [
        { feature: "a", specPath: `.nax/features/a/spec${mark}.md` },
        { feature: "b", specPath: SPEC_B, dependsOn: ["a"] },
      ],
    });

    await send(withFormat("\u{1d173}"));
    await send(withFormat("\u{1d174}"));

    const [first, second] = approveCalls;
    assertDefined(first, "the first approval card");
    assertDefined(second, "the second approval card");
    expect(first.reason).toContain("spec\\u{1d173}.md");
    expect(second.reason).toContain("spec\\u{1d174}.md");
    expect(first.reason).not.toBe(second.reason);
  });
});
