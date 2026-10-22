import { describe, expect, mock, test } from "bun:test";
import { NaxError } from "@/errors";
import type { ForgeDeps, PrRef } from "@/forge";
import * as forge from "@/forge";

const gh: PrRef = { forge: "github", host: "github.corp", repo: "acme/widgets", number: 7 };
const gl: PrRef = { forge: "gitlab", host: "gitlab.corp", repo: "group/sub/proj", number: 7 };
function fixture(reply: unknown, stderr = "") {
  const run = mock(async (_cmd: string[], _opts: { cwd: string }) => ({
    exitCode: stderr ? 1 : 0,
    stdout: JSON.stringify(reply),
    stderr,
  }));
  const deps: ForgeDeps = { run, readText: async () => null };
  return { deps, run };
}

describe("hasWriteAccess", () => {
  test.each([
    ["AC-1", "write", true],
    ["AC-2", "admin", true],
    ["AC-3", "read", false],
  ] as const)("%s GitHub permission %s", async (_ac, permission, expected) => {
    const { deps, run } = fixture({ permission });
    expect(await forge.hasWriteAccess(gh, { login: "a[bot]" }, deps, "/repo")).toBe(expected);
    expect(run.mock.calls).toEqual([
      [
        ["gh", "api", "--hostname", gh.host, "repos/acme/widgets/collaborators/a%5Bbot%5D/permission"],
        { cwd: "/repo" },
      ],
    ]);
  });
  test("AC-4 GitLab developer membership uses numeric author id", async () => {
    const { deps, run } = fixture({ access_level: 30 });
    expect(await forge.hasWriteAccess(gl, { login: "writer", id: 7 }, deps, "/repo")).toBe(true);
    expect(run.mock.calls).toEqual([
      [["glab", "api", "--hostname", gl.host, "projects/group%2Fsub%2Fproj/members/all/7"], { cwd: "/repo" }],
    ]);
  });
  test("AC-5 GitLab 404 means no membership", async () => {
    const { deps } = fixture(null, "404 Not Found");
    expect(await forge.hasWriteAccess(gl, { login: "writer", id: 7 }, deps, "/repo")).toBe(false);
  });
  test("AC-6 missing GitLab id throws before I/O", async () => {
    const { deps, run } = fixture({});
    const pending = forge.hasWriteAccess(gl, { login: "writer" }, deps, "/repo");
    await expect(pending).rejects.toBeInstanceOf(NaxError);
    await expect(pending).rejects.toMatchObject({ code: "FORGE_RESPONSE_UNPARSEABLE" });
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-7 missing GitHub permission throws NaxError", async () => {
    const { deps } = fixture({});
    await expect(forge.hasWriteAccess(gh, { login: "writer" }, deps, "/repo")).rejects.toBeInstanceOf(NaxError);
  });
  test.each([
    [20, false],
    [50, true],
  ] as const)("GitLab access level %s returns %s", async (access_level, expected) => {
    expect(await forge.hasWriteAccess(gl, { login: "writer", id: 7 }, fixture({ access_level }).deps, "/repo")).toBe(
      expected,
    );
  });
  test.each([{}, { access_level: "30" }, null, []])("rejects malformed membership %j", async (reply) => {
    await expect(
      forge.hasWriteAccess(gl, { login: "writer", id: 7 }, fixture(reply).deps, "/repo"),
    ).rejects.toMatchObject({
      code: "FORGE_RESPONSE_UNPARSEABLE",
      context: { stage: "forge" },
    });
  });
  test("GitLab non-404 failure throws", async () => {
    await expect(
      forge.hasWriteAccess(gl, { login: "writer", id: 7 }, fixture(null, "403 Forbidden").deps, "/repo"),
    ).rejects.toBeInstanceOf(NaxError);
  });
});
