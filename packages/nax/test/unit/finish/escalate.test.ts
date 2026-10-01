import { describe, expect, test } from "bun:test";
import type { Finding } from "@/finish";
import { buildEscalationComment, postEscalation } from "@/finish";
import type { ForgeDeps } from "@/forge";

const finding: Finding = {
  severity: "HIGH",
  title: "Missing rollback",
  problem: "The migration has no down path.",
  fix: "Add a reversible migration.",
} as Finding;

function depsFor(handler: (cmd: string[]) => { exitCode: number; stdout?: string; stderr?: string }): {
  deps: ForgeDeps;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      run: async (cmd) => {
        calls.push(cmd);
        const r = handler(cmd);
        return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
      readText: async () => null,
    },
  };
}

const args = { workdir: "/repo", branch: "feat/demo", comment: "escalation", forge: "github" as const };

describe("buildEscalationComment", () => {
  test("names the feature, the reason and every finding", () => {
    const text = buildEscalationComment("demo", "Two reviewers disagree", [finding]);
    expect(text).toContain("nax-finish escalation");
    expect(text).toContain("demo");
    expect(text).toContain("Two reviewers disagree");
    expect(text).toContain("Missing rollback");
    expect(text).toContain("Add a reversible migration.");
  });

  test("renders with no findings at all", () => {
    expect(buildEscalationComment("demo", "Context could not be resolved", [])).toContain("### Findings");
  });
});

describe("postEscalation", () => {
  test("comments on an existing PR", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 0, stdout: '{"url":"https://x/1"}' } : { exitCode: 0 },
    );
    await expect(postEscalation(args, deps)).resolves.toEqual({ url: "https://x/1", channel: "pr-comment" });
    expect(calls.at(-1)).toContain("comment");
  });

  test("opens a draft to hold the comment when no PR exists", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 1 } : { exitCode: 0, stdout: "https://x/2" },
    );
    await expect(postEscalation(args, deps)).resolves.toEqual({ url: "https://x/2", channel: "pr-comment" });
    expect(calls.at(-1)).toContain("--draft");
  });

  test("posts nothing and opens nothing when Telegram is preferred", async () => {
    const { deps, calls } = depsFor(() => ({ exitCode: 0, stdout: '{"url":"https://x/3"}' }));
    await expect(postEscalation({ ...args, preferTelegram: true }, deps)).resolves.toEqual({
      url: "https://x/3",
      channel: "telegram",
    });
    expect(calls).toHaveLength(1);
  });

  test("still reports the channel when Telegram is preferred and no PR exists", async () => {
    const { deps } = depsFor(() => ({ exitCode: 1 }));
    await expect(postEscalation({ ...args, preferTelegram: true }, deps)).resolves.toEqual({
      url: undefined,
      channel: "telegram",
    });
  });

  test("throws when the comment cannot be posted", async () => {
    const { deps } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 0, stdout: "{}" } : { exitCode: 1, stderr: "forbidden" },
    );
    await expect(postEscalation(args, deps)).rejects.toThrow(/forbidden/);
  });

  test("throws when the holding draft cannot be opened", async () => {
    const { deps } = depsFor((cmd) => (cmd.includes("view") ? { exitCode: 1 } : { exitCode: 1, stderr: "denied" }));
    await expect(postEscalation(args, deps)).rejects.toThrow(/denied/);
  });
});
