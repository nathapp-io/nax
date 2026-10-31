import { describe, expect, test } from "bun:test";
import type { ImageAttachment, SendInput } from "#src/index";
import * as agent from "#src/index";

const png = { mimeType: "image/png", data: "AAAA" };
const PER_IMAGE = 5_242_880;
const TOTAL = 20_971_520;
const large = { ...png, data: "A".repeat(PER_IMAGE) };
const input: SendInput = { images: [png] satisfies readonly ImageAttachment[] };

describe("validateImageAttachments", () => {
  test.each([
    ["AC-1", [png]],
    ["AC-8", [large]],
    ["AC-19", input.images ?? []],
    ["empty list", []],
    ["exact count", Array(10).fill(png)],
    ["exact total", Array(4).fill(large)],
  ])("%s accepts valid images", (_ac, images) => {
    expect(agent.validateImageAttachments(images)).toBeUndefined();
  });
  test.each([
    ["AC-2", Array(11).fill(png), "10"],
    ["AC-3", [{ ...png, mimeType: "image/bmp" }], "image/bmp"],
    ["AC-4", [{ ...png, data: "" }], "empty"],
    ["AC-5", [{ ...png, data: "AA$A" }], "not base64"],
    ["AC-6", [{ ...png, data: "AA" }], "not base64"],
    ["AC-7", [{ ...png, data: "A".repeat(PER_IMAGE + 4) }], String(PER_IMAGE)],
    ["AC-9", [{ ...png, width: 0, height: 10 }], "width"],
    ["AC-10", [{ ...png, width: 10, height: 2.5 }], "height"],
    ["AC-11", Array(5).fill(large), String(TOTAL)],
    ["AC-12", [{ ...png, mimeType: "image/bmp" }, ...Array(10).fill(png)], "10"],
    [
      "image order",
      [
        { ...png, width: 0 },
        { ...png, mimeType: "image/bmp" },
      ],
      "width",
    ],
    ["before total", [...Array(5).fill(large), { ...png, height: 0 }], "height"],
    ["MIME before empty", [{ ...png, mimeType: "image/bmp", data: "" }], "image/bmp"],
    ["empty before dimensions", [{ ...png, data: "", width: 0 }], "empty"],
    ["base64 before size", [{ ...png, data: "$".repeat(PER_IMAGE + 4) }], "not base64"],
    ["size before dimensions", [{ ...png, data: "A".repeat(PER_IMAGE + 4), width: 0 }], String(PER_IMAGE)],
    ["width before height", [{ ...png, width: 0, height: 0 }], "width"],
  ])("%s rejects invalid images in order", (_ac, images, reason) => {
    expect(agent.validateImageAttachments(images)).toContain(reason);
  });
  test.each(["image/png", "image/jpeg", "image/gif", "image/webp"])("accepts %s", (mimeType) => {
    expect(agent.validateImageAttachments([{ ...png, mimeType, width: 1, height: 2 }])).toBeUndefined();
  });
  test.each(["AA==", "AAA=", "ab+/"])("accepts base64 %s", (data) => {
    expect(agent.validateImageAttachments([{ ...png, data }])).toBeUndefined();
  });
  test.each(["A===", "A=AA", "AAA\n", "AA_A", "AA-A"])("rejects malformed base64 %j", (data) => {
    expect(agent.validateImageAttachments([{ ...png, data }])).toContain("not base64");
  });
  test.each(["width", "height"] as const)("rejects invalid %s values", (dimension) => {
    for (const value of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(agent.validateImageAttachments([{ ...png, [dimension]: value }])).toContain(dimension);
    }
  });
});

describe("public image constants", () => {
  test("AC-13 exports the accepted MIME types", () => {
    expect(agent.IMAGE_MIME_TYPES).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  });
  test.each([
    ["AC-14", agent.MAX_IMAGES_PER_MESSAGE, 10],
    ["AC-15", agent.MAX_IMAGE_BASE64_CHARS, PER_IMAGE],
    ["AC-16", agent.MAX_REQUEST_IMAGES, 20],
    ["AC-17", agent.MAX_REQUEST_IMAGE_BASE64_CHARS, TOTAL],
    ["AC-18", agent.IMAGE_TOKEN_ESTIMATE, 1_600],
  ] as const)("%s exports the expected limit", (_ac, actual, value) => {
    expect(actual).toBe(value);
  });
});
