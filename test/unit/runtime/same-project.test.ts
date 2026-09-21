/**
 * Unit tests for the isSameProject predicate.
 *
 * The predicate is the SSOT for "do two remote strings refer to the same
 * project?", shared by claimProjectIdentity (src/runtime/paths.ts) and
 * checkInitCollision (src/cli/init.ts). It must normalize both sides before
 * comparing.
 */

import { describe, expect, it } from "bun:test";
import { isSameProject } from "@/runtime";

describe("isSameProject", () => {
  it("returns true when ssh and https spellings of the same repo match", () => {
    expect(isSameProject("git@github.com:o/r.git", "https://github.com/o/r")).toBe(true);
  });

  it("returns true when https and ssh spellings of the same repo match (reversed)", () => {
    expect(isSameProject("https://github.com/o/r", "git@github.com:o/r.git")).toBe(true);
  });

  it("returns false for the same path on different hosts (GitHub vs GitLab fork)", () => {
    expect(isSameProject("https://github.com/o/r", "https://gitlab.com/o/r")).toBe(false);
  });

  it("returns false for forks on the same host but different owners", () => {
    expect(isSameProject("https://github.com/alice/r", "https://github.com/bob/r")).toBe(false);
  });

  it("returns true for two spellings differing only by letter case and trailing slash", () => {
    expect(isSameProject("https://github.com/o/r/", "HTTPS://GitHub.com/o/r")).toBe(true);
  });

  it("returns true when one side has a credential user:pass@ prefix and the other does not", () => {
    expect(isSameProject("https://user:pass@github.com/o/r.git", "https://github.com/o/r.git")).toBe(true);
  });

  it("returns true when one side has a credential user@ prefix and the other does not", () => {
    expect(isSameProject("https://user@github.com/o/r.git", "https://github.com/o/r.git")).toBe(true);
  });

  it("returns true when one side has an explicit port and the other does not", () => {
    expect(isSameProject("https://github.com:443/o/r.git", "https://github.com/o/r.git")).toBe(true);
  });

  it("returns true for scp-style and https spellings of the same repo", () => {
    expect(isSameProject("git@github.com:o/r.git", "ssh://git@github.com/o/r.git")).toBe(true);
  });

  it("returns true for ssh:// vs scp-style host:path spellings of the same repo", () => {
    expect(isSameProject("ssh://git@github.com/o/r.git", "git@github.com:o/r")).toBe(true);
  });

  it("returns true when only a trailing .git suffix differs", () => {
    expect(isSameProject("https://github.com/o/r.git", "https://github.com/o/r")).toBe(true);
  });

  it("returns true when both sides have only a .git suffix", () => {
    expect(isSameProject("https://github.com/o/r.git", "https://github.com/o/r.git")).toBe(true);
  });

  it("returns true when only a trailing slash differs", () => {
    expect(isSameProject("https://github.com/o/r/", "https://github.com/o/r")).toBe(true);
  });

  it("returns true when git:// and https:// spellings match", () => {
    expect(isSameProject("git://github.com/o/r.git", "https://github.com/o/r")).toBe(true);
  });

  it("returns false when the first argument is null", () => {
    expect(isSameProject(null, "https://github.com/o/r")).toBe(false);
  });

  it("returns false when the second argument is null", () => {
    expect(isSameProject("https://github.com/o/r", null)).toBe(false);
  });

  it("returns false when both arguments are null", () => {
    expect(isSameProject(null, null)).toBe(false);
  });

  it("returns false for the same path under different paths (fork under different paths)", () => {
    expect(isSameProject("https://github.com/o/r1", "https://github.com/o/r2")).toBe(false);
  });
});
