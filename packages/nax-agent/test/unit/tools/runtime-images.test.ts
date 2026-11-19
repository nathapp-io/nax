/**
 * US-002 — a tool that produced images hands them back on its outcome.
 *
 * Split from `runtime.test.ts` (which is at its 800-line test cap, the same
 * reason `runtime-command-shadow.test.ts` exists) by concern: the outcome
 * shaping a tool's images travel through, not the policy, the ask chain or the
 * ledger those suites cover.
 *
 * Only a SUCCESSFUL result carries them, and only when it has some: an error
 * outcome never claims the model was shown a picture, and an empty list stays
 * absent the way `isError` does.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { ImageAttachment } from "#src/cost/standard-types";
import { compileToolPolicy, createCodingToolRuntime, type ToolResult } from "#src/tools/index";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const ROOT = makeTempDir("nax-runtime-images-");

afterAll(() => cleanupTempDir(ROOT));

const PNG_A: ImageAttachment = { mimeType: "image/png", data: "AAAA", width: 2, height: 2 };

/** A granted tool whose one result is fixed, so only the outcome assembly is under test. */
function runtimeFor(result: ToolResult) {
  return createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: "Image", patterns: ["*"] }], ROOT),
    extraTools: [
      {
        name: "Image",
        description: "Return the image a tool produced",
        inputSchema: { type: "object", properties: {} },
        scope: { pathFields: [] },
        run: async () => result,
      },
    ],
  });
}

describe("callTool — tool-result images (US-002)", () => {
  test("AC-1: an ok outcome carries the tool's images", async () => {
    const outcome = await runtimeFor({ content: "x", images: [PNG_A] }).callTool("Image", {});
    expect(outcome).toEqual({ kind: "ok", content: "x", images: [PNG_A] });
  });

  test("AC-2: the deferred outcome carries images beside a callable finalizeAudit", async () => {
    const outcome = await runtimeFor({ content: "x", images: [PNG_A] }).callTool(
      "Image",
      {},
      {
        deferModelTruncation: true,
      },
    );
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.images).toEqual([PNG_A]);
    expect(typeof outcome.finalizeAudit).toBe("function");
  });

  test("AC-3: an error outcome carries no images key", async () => {
    const outcome = await runtimeFor({ content: "bad", isError: true, images: [PNG_A] }).callTool("Image", {});
    expect(outcome).toEqual({ kind: "error", content: "bad" });
    expect(outcome).not.toHaveProperty("images");
  });

  test("AC-4: an empty image list stays absent", async () => {
    const outcome = await runtimeFor({ content: "x", images: [] }).callTool("Image", {});
    expect(outcome).toEqual({ kind: "ok", content: "x" });
    expect(outcome).not.toHaveProperty("images");
  });
});
