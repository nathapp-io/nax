import { describe, expect, test } from "bun:test";
import { NATIVE_AGENT } from "@nathapp/nax-agent";
import { NATIVE_AGENT_NAME } from "@nathapp/nax-agent/internal";
import { NATIVE_AGENT_NAME as fromConfigBarrel } from "@/config";

describe("@/config/native-agent", () => {
  test("is the one definition the config barrel and the native barrel re-export", () => {
    expect(NATIVE_AGENT_NAME).toBe("native");
    expect(fromConfigBarrel).toBe(NATIVE_AGENT_NAME);
    expect(NATIVE_AGENT).toBe(NATIVE_AGENT_NAME);
  });
});
