import { afterEach, describe, expect, mock, test } from "bun:test";
import { resolveProviderTools, type ToolRunContext } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import type { ForgeDeps, JobLogRead, PrRef } from "@/forge";
import { _forgeToolsDeps, createForgeReadProvider } from "@/forge-tools";

const original = { ..._forgeToolsDeps };
afterEach(() => Object.assign(_forgeToolsDeps, original));

describe("bound log through provider advertisement", () => {
  test("AC-5 authorizes current head then reads the bound check through readJobLog", async () => {
    const ref: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 42 };
    const deps: ForgeDeps = {
      run: mock(async (argv) => {
        const endpoint = argv.at(-1);
        const payload = endpoint?.includes("check-runs")
          ? {
              check_runs: [
                { id: 7, name: "test", status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
              ],
            }
          : {
              number: 42,
              title: "PR",
              body: "",
              html_url: "u",
              state: "open",
              draft: false,
              user: { login: "bot" },
              base: { ref: "main" },
              head: { ref: "fix", sha: "abc", repo: { full_name: "o/r" } },
            };
        return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
      }),
      readText: async () => null,
    };
    _forgeToolsDeps.readJobLog = mock(async (): Promise<JobLogRead> => ({ ok: true, text: "integration log" }));
    const ctx: ToolRunContext = { root: "/unrelated", resolvedPaths: [], maxBytes: 2_000, maxFileBytes: 2_000 };
    const resolved = await resolveProviderTools(
      [createForgeReadProvider({ resolveRef: async () => ref, deps, cwd: "/bound" })],
      "run",
      ctx.root,
    );
    const log = resolved.tools.find((entry) => entry.name === "nax-forge__log");
    assertDefined(log);
    const result = await log.run({ check: "7" }, ctx);
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("1: integration log");
    expect(_forgeToolsDeps.readJobLog).toHaveBeenCalledWith(ref, "7", deps, "/bound");
    expect(deps.run).toHaveBeenCalledWith(
      ["gh", "api", "--hostname", "github.com", "repos/o/r/commits/abc/check-runs?per_page=100&filter=latest"],
      { cwd: "/bound" },
    );
  });
});
