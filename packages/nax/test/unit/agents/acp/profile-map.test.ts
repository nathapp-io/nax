import { describe, expect, test } from "bun:test";
import { acpProfileFor } from "@/agents/acp/profile-map";

describe("acpProfileFor (S4b spec §6.4)", () => {
  test("approve-all maps to full", () => {
    expect(acpProfileFor("approve-all")).toBe("full");
  });

  test("approve-reads maps to read", () => {
    expect(acpProfileFor("approve-reads")).toBe("read");
  });

  test("default maps to read, never wider", () => {
    expect(acpProfileFor("default")).toBe("read");
  });

  test("a read-only declaration narrows approve-all to read (nax#2444 D2)", () => {
    expect(acpProfileFor("approve-all", ["Read", "Glob", "Grep"])).toBe("read");
  });

  test("the materialized default declaration (read tools + scratchpad) narrows to read", () => {
    expect(
      acpProfileFor("approve-all", ["Read", "Glob", "Grep", "ScratchpadWrite", "ScratchpadRead", "ScratchpadList"]),
    ).toBe("read");
  });

  test("a declaration with a write tool keeps the mode's profile", () => {
    expect(acpProfileFor("approve-all", ["Read", "Write"])).toBe("full");
  });

  test("git-write and command tools count as write-class", () => {
    expect(acpProfileFor("approve-all", ["Read", "GitCommit"])).toBe("full");
    expect(acpProfileFor("approve-all", ["Read", "Bash"])).toBe("full");
    expect(acpProfileFor("approve-all", ["Read", "Exec", "RunCommand"])).toBe("full");
  });

  test("no declaration: mode alone (unchanged)", () => {
    expect(acpProfileFor("approve-all", undefined)).toBe("full");
    expect(acpProfileFor("approve-all", [])).toBe("full");
  });
});
