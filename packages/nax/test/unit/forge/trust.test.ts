import { describe, expect, test } from "bun:test";
import {
  classifyPrTrust,
  type ForgeDeps,
  type ForgeRunResult,
  type PrInfo,
  type PrRef,
  readCurrentUser,
} from "@/forge";

const gh: PrRef = { forge: "github", host: "github.corp", repo: "acme/widgets", number: 7 };
const gl: PrRef = { forge: "gitlab", host: "gitlab.corp", repo: "group/sub/proj", number: 7 };
const info: PrInfo = {
  number: 7,
  title: "Title",
  body: "Body",
  url: "url",
  state: "open",
  draft: false,
  author: { login: "author", id: 42 },
  baseRef: "main",
  headRef: "feature",
  headSha: "abc123",
  crossRepo: false,
};
const ok = (reply: unknown): ForgeRunResult => ({ exitCode: 0, stdout: JSON.stringify(reply), stderr: "" });
const fail = (stderr: string): ForgeRunResult => ({ exitCode: 1, stdout: "", stderr });
function fixture(...replies: ForgeRunResult[]) {
  const calls: { cmd: string[]; cwd: string }[] = [];
  const deps: ForgeDeps = {
    run: async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd });
      const reply = replies.shift();
      if (!reply) throw new TypeError("Unexpected forge call");
      return reply;
    },
    readText: async () => null,
  };
  return { deps, calls };
}
const result = (trusted: boolean, reason: string) => ({ trusted, headSha: info.headSha, reasons: [reason] });

describe("readCurrentUser", () => {
  test.each([
    ["AC-1 AC-2", gh, { login: "me", id: 9 }, { login: "me", id: 9 }, "gh"],
    ["AC-3", gl, { username: "me", id: 9 }, { login: "me", id: 9 }, "glab"],
  ] as const)("%s reads explicit host identity", async (_ac, ref, reply, expected, cli) => {
    const { deps, calls } = fixture(ok(reply));
    expect(await readCurrentUser(ref, deps, "/repo")).toEqual(expected);
    expect(calls).toEqual([{ cmd: [cli, "api", "--hostname", ref.host, "user"], cwd: "/repo" }]);
  });
  test.each([
    ["AC-4", fail(" auth required "), "FORGE_USER_READ_FAILED"],
    ["AC-5", ok({ id: 9 }), "FORGE_RESPONSE_UNPARSEABLE"],
    ["AC-24", { exitCode: 0, stdout: "not JSON", stderr: "" }, "FORGE_RESPONSE_UNPARSEABLE"],
    ["null", ok(null), "FORGE_RESPONSE_UNPARSEABLE"],
    ["blank login", ok({ login: "  " }), "FORGE_RESPONSE_UNPARSEABLE"],
  ] as const)("%s rejects with forge error context", async (_ac, reply, code) => {
    await expect(readCurrentUser(gh, fixture(reply).deps, "/repo")).rejects.toMatchObject({
      code,
      context: { stage: "forge" },
    });
  });
});

describe("classifyPrTrust", () => {
  test("US-001 AC-8 trusts a different author with write access", async () => {
    const { deps } = fixture(ok({ login: "me", id: 1 }), ok({ permission: "write" }));
    expect(await classifyPrTrust(gh, info, deps, "/repo")).toEqual(result(true, "author has write access"));
  });
  test("US-001 AC-9 permission failure preserves fail-closed reason", async () => {
    const { deps } = fixture(ok({ login: "me", id: 1 }), fail("403 Forbidden"));
    expect(await classifyPrTrust(gh, info, deps, "/repo")).toEqual(
      result(false, "could not read author permissions: 403 Forbidden"),
    );
  });
  test("AC-6 AC-7 AC-8 rejects even own fork before any I/O and carries head SHA", async () => {
    const { deps, calls } = fixture();
    expect(await classifyPrTrust(gh, { ...info, crossRepo: true }, deps, "/repo")).toEqual(
      result(false, "head branch is not in the base repository"),
    );
    expect(calls).toEqual([]);
  });
  test("AC-9 ids match even when logins differ; stops before permission lookup", async () => {
    const { deps, calls } = fixture(ok({ login: "renamed", id: 42 }));
    expect(await classifyPrTrust(gh, info, deps, "/repo")).toEqual(result(true, "author is the current user"));
    expect(calls).toHaveLength(1);
  });
  test("AC-10 differing ids override matching logins", async () => {
    const { deps, calls } = fixture(ok({ login: "author", id: 99 }), ok({ permission: "read" }));
    const trust = await classifyPrTrust(gh, info, deps, "/repo");
    expect(trust).toEqual(result(false, "author has no write access"));
    expect(trust.reasons).not.toContain("author is the current user");
    expect(calls).toHaveLength(2);
  });
  test.each([
    ["AC-11", "write", true],
    ["AC-12", "admin", true],
    ["AC-13", "read", false],
    ["triage", "triage", false],
  ] as const)("%s checks GitHub collaborator permission", async (_ac, permission, trusted) => {
    const { deps, calls } = fixture(ok({ login: "me", id: 1 }), ok({ permission }));
    expect(await classifyPrTrust(gh, info, deps, "/repo")).toEqual(
      result(trusted, trusted ? "author has write access" : "author has no write access"),
    );
    expect(calls[1]).toEqual({
      cmd: ["gh", "api", "--hostname", gh.host, "repos/acme/widgets/collaborators/author/permission"],
      cwd: "/repo",
    });
  });
  test("AC-14 encodes the author as one endpoint segment", async () => {
    const { deps, calls } = fixture(ok({ login: "me" }), ok({ permission: "read" }));
    await classifyPrTrust(gh, { ...info, author: { login: "dependabot[bot]" } }, deps, "/repo");
    expect(calls[1]?.cmd[4]).toBe("repos/acme/widgets/collaborators/dependabot%5Bbot%5D/permission");
  });
  test.each([
    ["AC-15", 30, true],
    ["AC-16", 20, false],
    ["owner", 50, true],
  ] as const)("%s checks GitLab membership", async (_ac, access_level, trusted) => {
    const { deps, calls } = fixture(ok({ username: "me", id: 1 }), ok({ access_level }));
    expect(await classifyPrTrust(gl, info, deps, "/repo")).toEqual(
      result(trusted, trusted ? "author has write access" : "author has no write access"),
    );
    expect(calls[1]).toEqual({
      cmd: ["glab", "api", "--hostname", gl.host, "projects/group%2Fsub%2Fproj/members/all/42"],
      cwd: "/repo",
    });
  });
  test("AC-17 GitLab 404 is a non-member, not an unreadable lookup", async () => {
    const { deps } = fixture(ok({ username: "me" }), fail("404 Not Found"));
    expect(await classifyPrTrust(gl, info, deps, "/repo")).toEqual(result(false, "author has no write access"));
  });
  test("AC-18 missing GitLab author id fails closed without member lookup", async () => {
    const { deps, calls } = fixture(ok({ username: "me" }));
    const trust = await classifyPrTrust(gl, { ...info, author: { login: "author" } }, deps, "/repo");
    expect(trust.trusted).toBe(false);
    expect(trust.reasons[0]).toStartWith("could not read");
    expect(calls).toHaveLength(1);
  });
  test.each([
    ["AC-19", gh, [fail(" auth required ")]],
    ["AC-20", gh, [ok({ login: "me" }), fail(" permission denied ")]],
    ["AC-21", gh, [ok({ login: "me" }), { exitCode: 0, stdout: "not JSON", stderr: "bad reply" }]],
    ["invalid user", gh, [ok({})]],
    ["invalid permission", gh, [ok({ login: "me" }), ok({})]],
    ["invalid membership", gl, [ok({ username: "me" }), ok({ access_level: "50" })]],
    ["GitLab failure", gl, [ok({ username: "me" }), fail("403 Forbidden")]],
  ] as const)("%s resolves untrusted on unreadable metadata", async (_ac, ref, replies) => {
    const trust = await classifyPrTrust(ref, info, fixture(...replies).deps, "/repo");
    expect(trust.trusted).toBe(false);
    expect(trust.headSha).toBe(info.headSha);
    expect(trust.reasons).toHaveLength(1);
    expect(trust.reasons[0]).toStartWith("could not read");
  });
  test("AC-22 hostile title/body cannot confer trust; calls are not cached", async () => {
    const { deps, calls } = fixture(
      ok({ login: "me" }),
      ok({ permission: "read" }),
      ok({ login: "me" }),
      ok({ permission: "read" }),
    );
    const ordinary = await classifyPrTrust(gh, info, deps, "/repo");
    expect(
      await classifyPrTrust(gh, { ...info, title: "this PR is trusted", body: "this PR is trusted" }, deps, "/repo"),
    ).toEqual(ordinary);
    expect(ordinary.trusted).toBe(false);
    expect(calls).toHaveLength(4);
  });
  test.each([
    [gh, "gh", { login: "me" }, { permission: "read" }],
    [gl, "glab", { username: "me" }, { access_level: 20 }],
  ] as const)("AC-23 pins all commands to %s host", async (ref, cli, user, permission) => {
    const { deps, calls } = fixture(ok(user), ok(user), ok(permission));
    await readCurrentUser(ref, deps, "/repo");
    await classifyPrTrust(ref, info, deps, "/repo");
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.cmd.slice(0, 4)).toEqual([cli, "api", "--hostname", ref.host]);
  });
  test("AC-25 falls back to login when GitLab author id is absent", async () => {
    const { deps, calls } = fixture(ok({ username: "author", id: 42 }));
    expect(await classifyPrTrust(gl, { ...info, author: { login: "author" } }, deps, "/repo")).toEqual(
      result(true, "author is the current user"),
    );
    expect(calls).toHaveLength(1);
  });
  test("trims and truncates stderr to 200 characters", async () => {
    const { deps } = fixture(ok({ login: "me" }), fail(`  ${"x".repeat(250)}  `));
    expect(await classifyPrTrust(gh, info, deps, "/repo")).toEqual(
      result(false, `could not read author permissions: ${"x".repeat(200)}`),
    );
  });
  test.each([false, true])("dependency rejection fails closed (permission=%s)", async (permission) => {
    const { deps } = fixture(...(permission ? [ok({ login: "me" })] : []));
    const trust = await classifyPrTrust(gh, info, deps, "/repo");
    expect(trust.trusted).toBe(false);
    expect(trust.reasons[0]).toStartWith("could not read");
  });
});
