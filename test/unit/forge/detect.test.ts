import { describe, expect, test } from "bun:test";
import { detectForge, type ForgeDeps, forgeFromRemoteUrl, remoteHost } from "@/forge";

function deps(handler: (cmd: string[]) => { exitCode: number; stdout: string; stderr: string }): ForgeDeps {
  return {
    run: async (cmd) => handler(cmd),
    readText: async () => null,
  };
}

const OK = { exitCode: 0, stdout: "", stderr: "" };
const MISSING = { exitCode: 127, stdout: "", stderr: "command not found" };

describe("remoteHost", () => {
  test("reads the host from an scp-style remote", () => {
    expect(remoteHost("git@github.com:owner/repo.git")).toBe("github.com");
  });

  test("reads the host from a URL-style remote, ignoring userinfo and port", () => {
    expect(remoteHost("https://user@gitlab.example.com:8443/team/repo.git")).toBe("gitlab.example.com");
  });

  test("returns empty string for something that is not a remote URL", () => {
    expect(remoteHost("not a url")).toBe("");
  });
});

describe("forgeFromRemoteUrl", () => {
  test("classifies github.com and gitlab.com", () => {
    expect(forgeFromRemoteUrl("git@github.com:owner/repo.git")).toBe("github");
    expect(forgeFromRemoteUrl("https://gitlab.com/team/repo.git")).toBe("gitlab");
  });

  // The defect this module exists to fix. `"gitlab.mycorp.com".includes("gitlab.com")`
  // is false, so the auto-PR plugin's substring check returned null here and the
  // plugin skipped itself on every self-hosted forge.
  test("classifies a self-hosted GitLab host", () => {
    expect(forgeFromRemoteUrl("git@gitlab.mycorp.com:team/repo.git")).toBe("gitlab");
  });

  test("classifies a self-hosted GitHub Enterprise host", () => {
    expect(forgeFromRemoteUrl("https://github.mycorp.com/team/repo.git")).toBe("github");
  });

  test("returns null for a host naming neither forge", () => {
    expect(forgeFromRemoteUrl("git@git.corp.com:team/repo.git")).toBeNull();
  });
});

describe("detectForge", () => {
  test("classifies from the remote when the host names a forge", async () => {
    const d = deps((cmd) =>
      cmd[0] === "git" ? { exitCode: 0, stdout: "git@gitlab.mycorp.com:t/r.git\n", stderr: "" } : MISSING,
    );
    expect(await detectForge(d, "/repo")).toBe("gitlab");
  });

  test("falls back to the installed CLI when the host names neither forge", async () => {
    const d = deps((cmd) => {
      if (cmd[0] === "git") return { exitCode: 0, stdout: "git@git.corp.com:t/r.git\n", stderr: "" };
      if (cmd[0] === "glab") return OK;
      return MISSING;
    });
    expect(await detectForge(d, "/repo")).toBe("gitlab");
  });

  test("stays undecided when both CLIs are installed", async () => {
    const d = deps((cmd) =>
      cmd[0] === "git" ? { exitCode: 0, stdout: "git@git.corp.com:t/r.git\n", stderr: "" } : OK,
    );
    expect(await detectForge(d, "/repo")).toBeNull();
  });

  test("stays undecided when neither CLI is installed", async () => {
    const d = deps((cmd) =>
      cmd[0] === "git" ? { exitCode: 0, stdout: "git@git.corp.com:t/r.git\n", stderr: "" } : MISSING,
    );
    expect(await detectForge(d, "/repo")).toBeNull();
  });

  test("returns null when the remote cannot be read at all", async () => {
    const d = deps(() => ({ exitCode: 128, stdout: "", stderr: "no such remote 'origin'" }));
    expect(await detectForge(d, "/repo")).toBeNull();
  });
});
