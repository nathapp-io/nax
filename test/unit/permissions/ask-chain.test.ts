import { describe, expect, test } from "bun:test";
import { type AskControl, type AskLink, chainAskLinks } from "@/permissions";

const REQ = { tool: "Bash", stage: "implementer", rule: "Bash", summary: "Bash command=x" };

function link(name: string, decision: "allow" | "deny" | "abstain", decidedBy: "cache" | "human"): AskLink {
  return { name, resolve: () => Promise.resolve({ decision, decidedBy }) };
}

describe("chainAskLinks", () => {
  test("an empty chain denies, attributed to unavailable", async () => {
    const verdict = await chainAskLinks([]).resolve(REQ);
    expect(verdict.decision).toBe("deny");
    expect(verdict.decidedBy).toBe("unavailable");
  });

  test("the first non-abstain link wins and names itself", async () => {
    const verdict = await chainAskLinks([link("cache", "abstain", "cache"), link("human", "allow", "human")]).resolve(
      REQ,
    );
    expect(verdict.decision).toBe("allow");
    expect(verdict.decidedBy).toBe("human");
  });

  test("a later link is never consulted once one decides", async () => {
    let reached = false;
    const spy: AskLink = {
      name: "human",
      resolve: () => {
        reached = true;
        return Promise.resolve({ decision: "allow" as const, decidedBy: "human" as const });
      },
    };
    await chainAskLinks([link("cache", "allow", "cache"), spy]).resolve(REQ);
    expect(reached).toBe(false);
  });

  test("all-abstain denies: the terminal link cannot abstain", async () => {
    const verdict = await chainAskLinks([link("cache", "abstain", "cache"), link("human", "abstain", "human")]).resolve(
      REQ,
    );
    expect(verdict.decision).toBe("deny");
    expect(verdict.decidedBy).toBe("unavailable");
  });

  test("a throwing link denies rather than escaping", async () => {
    const boom: AskLink = { name: "human", resolve: () => Promise.reject(new Error("transport down")) };
    const verdict = await chainAskLinks([boom]).resolve(REQ);
    expect(verdict.decision).toBe("deny");
    expect(verdict.decidedBy).toBe("unavailable");
  });

  test("latency is reported", async () => {
    const verdict = await chainAskLinks([link("cache", "allow", "cache")]).resolve(REQ);
    expect(verdict.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("US-003 — control forwarding", () => {
  test("AC2: resolve forwards the same control object to a single link", async () => {
    const received: Array<AskControl | undefined> = [];
    const spy: AskLink = {
      name: "human",
      resolve: (_req, control) => {
        received.push(control);
        return Promise.resolve({ decision: "allow", decidedBy: "human" });
      },
    };
    const signal = new AbortController().signal;
    const control: AskControl = { signal, onWaiting: () => {} };
    await chainAskLinks([spy]).resolve(REQ, control);
    expect(received).toEqual([control]);
  });

  test("AC2: every link in the chain receives the same control object", async () => {
    const received: Array<AskControl | undefined> = [];
    const cache: AskLink = {
      name: "cache",
      resolve: (_req, control) => {
        received.push(control);
        return Promise.resolve({ decision: "abstain", decidedBy: "cache" });
      },
    };
    const human: AskLink = {
      name: "human",
      resolve: (_req, control) => {
        received.push(control);
        return Promise.resolve({ decision: "allow", decidedBy: "human" });
      },
    };
    const control: AskControl = { onWaiting: () => {} };
    await chainAskLinks([cache, human]).resolve(REQ, control);
    expect(received).toEqual([control, control]);
  });
});
