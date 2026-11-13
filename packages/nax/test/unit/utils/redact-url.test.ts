/**
 * redact-url.ts — URL userinfo redaction for text a user or a transcript sees.
 *
 * A remote URL routinely carries a pasted token in front of its host, so the
 * tests here drive both shapes that reach a message: a bare URL and git's own
 * stderr, which quotes the destination inside prose.
 */

import { describe, expect, test } from "bun:test";
import { redactUrlUserinfo } from "@/utils/redact-url";

describe("redactUrlUserinfo", () => {
  test.each([
    ["a token and a password", "https://x-access-token:secret@github.com/o/r.git", "https://***@github.com/o/r.git"],
    ["a bare token as the user", "https://ghp_tokenvalue@github.com/o/r.git", "https://***@github.com/o/r.git"],
    ["an empty user with a password", "https://:hunter2@gitlab.com/o/r.git", "https://***@gitlab.com/o/r.git"],
    ["an ssh URL", "ssh://git@github.com/o/r.git", "ssh://***@github.com/o/r.git"],
  ])("redacts the userinfo of %s and keeps scheme, host and path", (_label, url, expected) => {
    expect(redactUrlUserinfo(url)).toBe(expected);
  });

  test("keeps the whole userinfo out of the answer, not only its last segment", () => {
    const redacted = redactUrlUserinfo("https://user:p@ss@github.com/o/r.git");

    expect(redacted).toBe("https://***@github.com/o/r.git");
    expect(redacted).not.toContain("ss@");
  });

  test("leaves an SCP-style address alone: its user is the SSH account, not a credential", () => {
    expect(redactUrlUserinfo("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });

  test("leaves a credential-free URL untouched", () => {
    expect(redactUrlUserinfo("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });

  test("does not treat an @ in the path as userinfo", () => {
    expect(redactUrlUserinfo("https://github.com/o/r@main")).toBe("https://github.com/o/r@main");
  });

  test("redacts every URL inside prose, which is how git quotes a destination", () => {
    const stderr =
      "fatal: unable to access 'https://x-access-token:secret@github.com/o/r.git/': " +
      "The requested URL returned error: 403, see https://user:pw@example.com/help";

    const redacted = redactUrlUserinfo(stderr);

    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("user:pw");
    expect(redacted).toContain("'https://***@github.com/o/r.git/'");
    expect(redacted).toContain("https://***@example.com/help");
  });

  test("redacts a URL with no path", () => {
    expect(redactUrlUserinfo("https://user:secret@github.com")).toBe("https://***@github.com");
  });

  test("returns text without a URL unchanged", () => {
    expect(redactUrlUserinfo("remote rejected the update")).toBe("remote rejected the update");
  });
});
