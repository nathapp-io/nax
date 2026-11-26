import { describe, expect, test } from "bun:test";
import { createWebExposureGuard as createWebExposureGuardFromInternal } from "@nathapp/nax-agent/internal";
import { createWebExposure, type WebExposure } from "#src/web/exposure";
import { createWebExposureGuard, type WebCallAssessment } from "#src/web/guard";

/**
 * The reason strings are pinned here as literals rather than imported from the guard: each one
 * is the text a person reads on the approval line, so a change to it is a contract change and
 * this file should have to say so.
 */
const GIT_PUSH = "git push after this session read web content";
const FULL_NETWORK = "full network after this session read web content";
const UNSANDBOXED = "running outside the sandbox after this session read web content";
const SANDBOX_OFF = "the sandbox is off and this session read web content";
const UNSEEN_URL = "fetching a URL this session has not seen";

const REPO = "/repo";
const EXPOSED_AT = new Date("2026-11-26T10:00:00.000Z");

/** One assessment the guard judges, in the session's ordinary shape unless the test overrides it. */
function call(over: Partial<WebCallAssessment> & Pick<WebCallAssessment, "tool">): WebCallAssessment {
  return { input: {}, root: REPO, resolvedPaths: [], sandboxed: true, ...over };
}

/** A guard over `exposure`, carrying the two allowlists the guard's network members read. */
function guardOver(exposure: WebExposure) {
  return createWebExposureGuard({
    exposure,
    exposedAllowedDomains: ["https://github.com"],
    configuredAllowedDomains: undefined,
  });
}

/** A guard for a session that has already read the web. */
function exposedGuard() {
  const exposure = createWebExposure();
  exposure.markExposed(EXPOSED_AT);
  return guardOver(exposure);
}

/** A guard for an exposed session that already knows `urls`. */
function guardKnowing(urls: readonly string[]) {
  const exposure = createWebExposure();
  exposure.recordUrls(urls);
  exposure.markExposed(EXPOSED_AT);
  return guardOver(exposure);
}

/** The reason `assessment` draws from an exposed session's guard, or undefined for no decision. */
function reasonFor(assessment: WebCallAssessment): string | undefined {
  return exposedGuard().assess(assessment)?.reason;
}

describe("createWebExposureGuard", () => {
  describe("before the session has read the web", () => {
    test("leaves a Bash git push alone", () => {
      expect(
        guardOver(createWebExposure()).assess(call({ tool: "Bash", input: { command: "git push origin main" } })),
      ).toBeUndefined();
    });

    // Every row of the stop table, so "nothing asks before the first web result" is one
    // property of the guard rather than an accident of the shape the first test used.
    test.each([
      { label: "a git push", assessment: call({ tool: "Bash", input: { command: "git push origin main" } }) },
      {
        label: "a full-network Bash call",
        assessment: call({ tool: "Bash", input: { command: "ls", network: "full" } }),
      },
      {
        label: "an unsandboxed Bash call",
        assessment: call({ tool: "Bash", input: { command: "ls", unsandboxed: true } }),
      },
      { label: "an unsandboxed Exec call", assessment: call({ tool: "Exec", input: { argv: ["git", "fetch"] } }) },
      {
        label: "a Bash call with the sandbox off",
        assessment: call({ tool: "Bash", input: { command: "ls" }, sandboxed: false }),
      },
      { label: "an unseen fetch", assessment: call({ tool: "web__fetch", input: { url: "https://a.example/x" } }) },
    ])("leaves $label alone", ({ assessment }) => {
      expect(guardOver(createWebExposure()).assess(assessment)).toBeUndefined();
    });
  });

  describe("once the session has read the web", () => {
    describe("git push", () => {
      const PUSH = call({ tool: "Bash", input: { command: "git push origin main" } });

      test("answers a Bash git push under the web-exposure rule", () => {
        expect(exposedGuard().assess(PUSH)?.rule).toBe("web-exposure");
      });

      test("names the push as a git push after web content", () => {
        expect(reasonFor(PUSH)).toBe(GIT_PUSH);
      });

      test("finds a push behind a cd and a git -C", () => {
        expect(reasonFor(call({ tool: "Bash", input: { command: "cd x && git -C y push" } }))).toBe(GIT_PUSH);
      });

      test("leaves a git status alone", () => {
        expect(reasonFor(call({ tool: "Bash", input: { command: "git status" } }))).toBeUndefined();
      });

      test("leaves a push word in an earlier segment alone", () => {
        expect(reasonFor(call({ tool: "Bash", input: { command: "echo push; git log" } }))).toBeUndefined();
      });
    });

    describe("full network", () => {
      test("names a full-network Bash call", () => {
        expect(reasonFor(call({ tool: "Bash", input: { command: "curl https://a.example", network: "full" } }))).toBe(
          FULL_NETWORK,
        );
      });
    });

    describe("outside the sandbox", () => {
      test("names an unsandboxed Bash call", () => {
        expect(reasonFor(call({ tool: "Bash", input: { command: "ls", unsandboxed: true } }))).toBe(UNSANDBOXED);
      });

      test("names an unsandboxed Exec call", () => {
        expect(reasonFor(call({ tool: "Exec", input: { argv: ["ls"], unsandboxed: true } }))).toBe(UNSANDBOXED);
      });
    });

    describe("sandbox off", () => {
      test("names a Bash call with the sandbox off", () => {
        expect(reasonFor(call({ tool: "Bash", input: { command: "ls" }, sandboxed: false }))).toBe(SANDBOX_OFF);
      });

      test("names an Exec call with the sandbox off", () => {
        expect(reasonFor(call({ tool: "Exec", input: { argv: ["ls"] }, sandboxed: false }))).toBe(SANDBOX_OFF);
      });

      test("leaves a sandboxed Bash call alone", () => {
        expect(reasonFor(call({ tool: "Bash", input: { command: "ls" } }))).toBeUndefined();
      });
    });

    describe("tools with no row", () => {
      test("leaves a Write inside the repository alone", () => {
        const write = call({ tool: "Write", input: { path: "/repo/a.ts" }, resolvedPaths: ["/repo/a.ts"] });
        expect(exposedGuard().assess(write)).toBeUndefined();
      });

      test("leaves a Bash call that is a plain Read equivalent alone", () => {
        expect(reasonFor(call({ tool: "Bash", input: { command: "cat a.ts" } }))).toBeUndefined();
      });

      test("leaves a Read alone", () => {
        expect(
          reasonFor(call({ tool: "Read", input: { path: "/repo/a.ts" }, resolvedPaths: ["/repo/a.ts"] })),
        ).toBeUndefined();
      });
    });

    describe("fetching a URL", () => {
      test("leaves a URL the session has seen alone", () => {
        const guard = guardKnowing(["https://a.example/x"]);
        expect(guard.assess(call({ tool: "web__fetch", input: { url: "https://a.example/x" } }))).toBeUndefined();
      });

      test("leaves a seen URL alone when the call spells it differently", () => {
        const guard = guardKnowing(["https://a.example/x"]);
        expect(guard.assess(call({ tool: "web__fetch", input: { url: "HTTPS://A.example/x#f" } }))).toBeUndefined();
      });

      test("names an unseen URL", () => {
        const guard = guardKnowing(["https://a.example/x"]);
        expect(guard.assess(call({ tool: "web__fetch", input: { url: "https://a.example/?d=secret" } }))?.reason).toBe(
          UNSEEN_URL,
        );
      });
    });
  });

  describe("internal entry", () => {
    test("leaves a Read alone through @nathapp/nax-agent/internal", () => {
      const guard = createWebExposureGuardFromInternal({
        exposure: createWebExposure(),
        exposedAllowedDomains: [],
        configuredAllowedDomains: undefined,
      });
      expect(guard.assess(call({ tool: "Read", input: { path: "/repo/a.ts" } }))).toBeUndefined();
    });

    test("is the same guard the module exports", () => {
      const exposure = createWebExposure();
      exposure.markExposed(EXPOSED_AT);
      const guard = createWebExposureGuardFromInternal({
        exposure,
        exposedAllowedDomains: [],
        configuredAllowedDomains: undefined,
      });
      expect(guard.assess(call({ tool: "Bash", input: { command: "git push origin main" } }))?.reason).toBe(GIT_PUSH);
    });
  });
});
