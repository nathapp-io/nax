/**
 * US-005 — the native rule-delivery `before_tool` handler: who is nudged, with
 * what text, and under which cap.
 *
 * The handler is driven through the set it hands back
 * (`createRuleDeliveryHandlers`), with the payload and context the native loop
 * would pass it — see `@test/helpers` `callBeforeTool`. The repository is a real
 * temp directory, because the whole point of the handler is that "which rules
 * govern this file" is answered by the shared resolver and not by the handler:
 * a stubbed resolver would test the stub.
 *
 * The AC id is the test-name prefix. The run-scoped *state* (session map, the
 * caches, the fail-open path, the compaction reset) is pinned separately in
 * `rule-delivery-state.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  beforeToolPayload,
  callBeforeTool,
  handlerContext,
  outcomeText,
  seedPackage,
  seedRule,
  withInfoSpy,
  withTempDir,
} from "@test/helpers";
import {
  createRuleDeliveryHandlers,
  MAX_RULE_INJECTION_BYTES,
  RULE_DELIVERY_PLUGIN,
} from "@/context/rules/rule-delivery";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PACKAGE = "packages/nax";
const A_PATH = `${PACKAGE}/src/a.ts`;
const RULE_R_BODY = "RULE-R-BODY";
/** 9 KB of body: fits the cap alone, does not fit alongside another rule. */
const BIG_BODY = "b".repeat(9_000);
/** 10 KB: the AC-24 pair, whose sum (20 KB) is past the 16 KB cap. */
const PAIR_BODY = "p".repeat(10_000);

const read = (path: string) => beforeToolPayload("Read", { path });
const write = (path: string) => beforeToolPayload("Write", { path, content: "x" });
const edit = (path: string) => beforeToolPayload("Edit", { path, old_string: "x", new_string: "y" });

/** A repo whose `.nax/rules/r.md` governs `packages/nax/src/a.ts` and nothing else. */
async function seedRepo(repoRoot: string): Promise<void> {
  await seedPackage(repoRoot, PACKAGE);
  await seedRule(repoRoot, "r.md", `---\nappliesTo:\n  - ${A_PATH}\n---\n\n${RULE_R_BODY}\n`);
}

function handlersFor(repoRoot: string) {
  return createRuleDeliveryHandlers({ repoRoot, overrideMode: "merge" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery text and the entries themselves
// ─────────────────────────────────────────────────────────────────────────────

describe("createRuleDeliveryHandlers — the entries", () => {
  test("registers exactly one before_tool and one before_compaction entry, both plugin 'nax-rules'", () => {
    const set = handlersFor("/repo");

    expect(set.map((entry) => entry.plugin)).toEqual([RULE_DELIVERY_PLUGIN, RULE_DELIVERY_PLUGIN]);
    expect(set.map((entry) => entry.event)).toEqual(["before_tool", "before_compaction"]);
    for (const entry of set) expect(typeof entry.handler).toBe("function");
  });

  test("AC-15: the injection cap is 16,384 bytes", () => {
    expect(MAX_RULE_INJECTION_BYTES).toBe(16_384);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Role scope
// ─────────────────────────────────────────────────────────────────────────────

describe("before_tool — role scope", () => {
  test("AC-1: a wf-implementer Read of a governed file is nudged with the rule's body under its heading", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);

      const outcome = await callBeforeTool(
        set,
        read(A_PATH),
        handlerContext({ role: "wf-implementer", sessionName: "sess-impl" }),
      );

      expect(outcome.kind).toBe("nudge");
      const text = outcomeText(outcome);
      expect(text).toContain(`Rules that apply to ${A_PATH}:`);
      expect(text).toContain("### r (.nax/rules/r.md)");
      expect(text).toContain(RULE_R_BODY);
    });
  });

  test("AC-2: a second Read in the same session is allowed without a nudge", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);
      const ctx = handlerContext({ role: "wf-implementer", sessionName: "sess-impl" });

      expect((await callBeforeTool(set, read(A_PATH), ctx)).kind).toBe("nudge");
      expect(await callBeforeTool(set, read(A_PATH), ctx)).toEqual({ kind: "allow" });
    });
  });

  test("AC-3: the same Read in another session is nudged again, body included", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);

      await callBeforeTool(set, read(A_PATH), handlerContext({ role: "wf-story-review", sessionName: "sess-one" }));
      const second = await callBeforeTool(
        set,
        read(A_PATH),
        handlerContext({ role: "wf-story-review", sessionName: "sess-two" }),
      );

      expect(second.kind).toBe("nudge");
      expect(outcomeText(second)).toContain(RULE_R_BODY);
    });
  });

  test("AC-6: a wf-branch-fix Edit of a governed file is blocked", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);

      const outcome = await callBeforeTool(
        set,
        edit(A_PATH),
        handlerContext({ role: "wf-branch-fix", sessionName: "sess-branch-fix" }),
      );

      expect(outcome.kind).toBe("block");
      expect(outcomeText(outcome)).toContain(RULE_R_BODY);
    });
  });

  test("AC-7: a wf-story-review Write of a governed file is allowed — reviewers never mutate", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);

      const outcome = await callBeforeTool(
        set,
        write(A_PATH),
        handlerContext({ role: "wf-story-review", sessionName: "sess-review" }),
      );

      expect(outcome).toEqual({ kind: "allow" });
    });
  });

  test("AC-8: an advisor role and a context with no role are both allowed on a Read", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);

      const advisor = await callBeforeTool(set, read(A_PATH), handlerContext({ role: "advisor" }));
      const roleless = await callBeforeTool(set, read(A_PATH), handlerContext({}));

      expect(advisor).toEqual({ kind: "allow" });
      expect(roleless).toEqual({ kind: "allow" });
    });
  });

  test("only Read, Write and Edit are considered — a Bash call on a governed path is allowed", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);
      const ctx = handlerContext({ role: "wf-implementer" });

      expect(await callBeforeTool(set, beforeToolPayload("Bash", { command: `cat ${A_PATH}` }), ctx)).toEqual({
        kind: "allow",
      });
      expect(await callBeforeTool(set, beforeToolPayload("Git", { subcommand: "status" }), ctx)).toEqual({
        kind: "allow",
      });
      expect(await callBeforeTool(set, beforeToolPayload("Read", { path: A_PATH }), ctx)).not.toEqual({
        kind: "allow",
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path handling
// ─────────────────────────────────────────────────────────────────────────────

describe("before_tool — path handling", () => {
  test("AC-12: a './'-prefixed path is normalized and nudged with the rules of its normalized spelling", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);

      const outcome = await callBeforeTool(
        set,
        read(`./${A_PATH}`),
        handlerContext({ role: "wf-implementer", sessionName: "sess-dot-slash" }),
      );

      expect(outcome.kind).toBe("nudge");
      // The normalized spelling is what the text names, and what delivery keys on.
      expect(outcomeText(outcome)).toContain(`Rules that apply to ${A_PATH}:`);
    });
  });

  test("AC-12: an 'a/../' segment is normalized the same way", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);

      const outcome = await callBeforeTool(
        set,
        read(`${PACKAGE}/src/../src/a.ts`),
        handlerContext({ role: "wf-implementer", sessionName: "sess-dot-dot" }),
      );

      expect(outcome.kind).toBe("nudge");
      expect(outcomeText(outcome)).toContain(RULE_R_BODY);
    });
  });

  test("AC-9: a Read under .nax/ is allowed while a rule governing every file exists", async () => {
    await withTempDir(async (repoRoot) => {
      await seedPackage(repoRoot, PACKAGE);
      await seedRule(repoRoot, "always.md", "## Always\n\nALWAYS-BODY\n");
      const set = handlersFor(repoRoot);
      const ctx = handlerContext({ role: "wf-implementer", sessionName: "sess-nax-dir" });

      expect(await callBeforeTool(set, read(".nax/features/f/brief.md"), ctx)).toEqual({ kind: "allow" });
      // The rule really does govern everything: an ordinary file is nudged.
      expect((await callBeforeTool(set, read(`${PACKAGE}/src/x.ts`), ctx)).kind).toBe("nudge");
    });
  });

  test("AC-13: an absolute path outside the repo root that is no rule's file is allowed", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);

      const outcome = await callBeforeTool(
        set,
        read("/nax-delivery-outside/other.ts"),
        handlerContext({ role: "wf-implementer", sessionName: "sess-outside" }),
      );

      expect(outcome).toEqual({ kind: "allow" });
    });
  });

  test("a missing or non-string path is allowed", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);
      const ctx = handlerContext({ role: "wf-implementer" });
      const payloads = [
        beforeToolPayload("Read", {}),
        beforeToolPayload("Write", { path: 42 }),
        beforeToolPayload("Edit", { path: null }),
      ];

      for (const payload of payloads) {
        expect(await callBeforeTool(set, payload, ctx)).toEqual({ kind: "allow" });
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Write/Edit refuse-once
// ─────────────────────────────────────────────────────────────────────────────

describe("before_tool — the refuse-once block on Write and Edit", () => {
  test("AC-4: a wf-implementer Write of an undelivered governed file is blocked with the rule and the retry sentence", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);
      const ctx = handlerContext({ role: "wf-implementer", sessionName: "sess-write" });

      const outcome = await callBeforeTool(set, write(A_PATH), ctx);

      expect(outcome.kind).toBe("block");
      if (outcome.kind !== "block") return;
      expect(outcome.isError).toBe(true);
      expect(outcome.content).toContain(`### r (.nax/rules/r.md)`);
      expect(outcome.content).toContain(RULE_R_BODY);
      expect(
        outcome.content.trimEnd().endsWith("No files were changed. Review these rules and retry the tool call."),
      ).toBe(true);
    });
  });

  test("AC-5: retrying that Write in the same session is allowed", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);
      const ctx = handlerContext({ role: "wf-implementer", sessionName: "sess-write" });

      expect((await callBeforeTool(set, write(A_PATH), ctx)).kind).toBe("block");
      expect(await callBeforeTool(set, write(A_PATH), ctx)).toEqual({ kind: "allow" });
    });
  });

  test("a block in one session does not deliver the rule for another session", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);

      expect(
        (await callBeforeTool(set, write(A_PATH), handlerContext({ role: "wf-implementer", sessionName: "sess-one" })))
          .kind,
      ).toBe("block");
      expect(
        (await callBeforeTool(set, write(A_PATH), handlerContext({ role: "wf-implementer", sessionName: "sess-two" })))
          .kind,
      ).toBe("block");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The byte cap
// ─────────────────────────────────────────────────────────────────────────────

describe("before_tool — MAX_RULE_INJECTION_BYTES", () => {
  test("AC-15: bodies in priority order up to the cap, the rest listed by id and path only", async () => {
    await withTempDir(async (repoRoot) => {
      await seedPackage(repoRoot, PACKAGE);
      await seedRule(repoRoot, "hi.md", `---\npriority: 1\nappliesTo:\n  - ${A_PATH}\n---\n\n${BIG_BODY}\n`);
      await seedRule(repoRoot, "lo.md", `---\npriority: 2\nappliesTo:\n  - ${A_PATH}\n---\n\n${BIG_BODY}\n`);
      const set = handlersFor(repoRoot);

      const outcome = await callBeforeTool(
        set,
        read(A_PATH),
        handlerContext({ role: "wf-implementer", sessionName: "sess-cap" }),
      );

      expect(outcome.kind).toBe("nudge");
      const text = outcomeText(outcome);
      // Higher priority (lower number) first, so `hi` is the body that fits.
      expect(text).toContain("### hi (.nax/rules/hi.md)");
      expect(text).not.toContain("### lo (.nax/rules/lo.md)");
      expect(text).toContain("Also applies (not shown, open the file): lo (.nax/rules/lo.md)");
    });
  });

  test("AC-24: a body listed past the cap stays undelivered and arrives on a later qualifying call", async () => {
    await withTempDir(async (repoRoot) => {
      await seedPackage(repoRoot, PACKAGE);
      await seedRule(repoRoot, "hi.md", `---\npriority: 1\nappliesTo:\n  - ${A_PATH}\n---\n\n${PAIR_BODY}\n`);
      await seedRule(repoRoot, "lo.md", `---\npriority: 2\nappliesTo:\n  - ${A_PATH}\n---\n\n${PAIR_BODY}\n`);
      const set = handlersFor(repoRoot);
      const ctx = handlerContext({ role: "wf-implementer", sessionName: "sess-cap-later" });

      const first = await callBeforeTool(set, read(A_PATH), ctx);
      const firstText = outcomeText(first);
      expect(firstText).toContain("Also applies (not shown, open the file): lo (.nax/rules/lo.md)");

      const second = await callBeforeTool(set, read(A_PATH), ctx);

      expect(second.kind).toBe("nudge");
      const secondText = outcomeText(second);
      expect(secondText).toContain("### lo (.nax/rules/lo.md)");
      expect(secondText).not.toContain("Also applies");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry
// ─────────────────────────────────────────────────────────────────────────────

describe("before_tool — the rules.delivered event", () => {
  test("AC-21: a nudge logs one info event rules.delivered with storyId as the first data key", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);

      await withInfoSpy(async (infoSpy) => {
        await callBeforeTool(
          set,
          read(A_PATH),
          handlerContext({ role: "wf-implementer", sessionName: "sess-log", storyId: "US-005" }),
        );

        const events = infoSpy.mock.calls.filter((call) => call[0] === "rules" && call[1] === "rules.delivered");
        expect(events).toHaveLength(1);
        const data = events[0]?.[2];
        expect(data).toBeDefined();
        if (data === undefined) return;
        expect(Object.keys(data)[0]).toBe("storyId");
        expect(data.storyId).toBe("US-005");
      });
    });
  });

  test("AC-21: a block logs one info event rules.delivered with storyId as the first data key", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);

      await withInfoSpy(async (infoSpy) => {
        await callBeforeTool(
          set,
          write(A_PATH),
          handlerContext({ role: "wf-implementer", sessionName: "sess-log-write", storyId: "US-005" }),
        );

        const events = infoSpy.mock.calls.filter((call) => call[0] === "rules" && call[1] === "rules.delivered");
        expect(events).toHaveLength(1);
        const data = events[0]?.[2];
        expect(data).toBeDefined();
        if (data === undefined) return;
        expect(Object.keys(data)[0]).toBe("storyId");
      });
    });
  });

  test("an allow logs nothing", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRepo(repoRoot);
      const set = handlersFor(repoRoot);
      const ctx = handlerContext({ role: "advisor", sessionName: "sess-log-allow" });

      await withInfoSpy(async (infoSpy) => {
        await callBeforeTool(set, read(A_PATH), ctx);
        expect(infoSpy.mock.calls.filter((call) => call[1] === "rules.delivered")).toHaveLength(0);
      });
    });
  });
});
