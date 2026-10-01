import { expect, test } from "bun:test";
import { requestCapabilityTool } from "@/tools/request-capability";

const ctx = { root: "/tmp", resolvedPaths: [], maxBytes: 4096, maxFileBytes: 1024 };

test("records the want and refuses it", async () => {
  const result = await requestCapabilityTool.run({ capability: "bun install", reason: "module missing" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("bun install");
  expect(result.content).toContain("not available");
});

test("requires a capability string", async () => {
  const result = await requestCapabilityTool.run({ reason: "x" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("capability must be a non-empty string");
});

test("never runs anything -- reason is optional and free text", async () => {
  const result = await requestCapabilityTool.run({ capability: "rm -rf /" }, ctx);
  expect(result.isError).toBe(true);
  expect(result.content).toContain("rm -rf /");
});
