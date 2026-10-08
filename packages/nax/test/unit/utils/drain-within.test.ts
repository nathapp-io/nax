import { describe, expect, test } from "bun:test";
import { drainWithin } from "@/utils/drain-within";

describe("drainWithin", () => {
  test("returns the drained text when it settles in time", async () => {
    expect(await drainWithin(Promise.resolve("output"), 1_000)).toBe("output");
  });

  test("gives up with an empty string when the drain never settles", async () => {
    expect(await drainWithin(new Promise<string>(() => {}), 20)).toBe("");
  });
});
