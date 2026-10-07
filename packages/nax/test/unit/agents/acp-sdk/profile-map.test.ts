import { describe, expect, test } from "bun:test";
import { acpProfileFor } from "@/agents/acp-sdk/profile-map";

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
});
