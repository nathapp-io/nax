import { describe, expect, test } from "bun:test";
import { parseTraceparent } from "../../../../src/plugins/builtin/otel-reporter/traceparent";

describe("parseTraceparent", () => {
  test("AC12: a valid W3C traceparent yields its trace id and parent (span) id", () => {
    const result = parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(result).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
    });
  });

  test("AC13: a malformed traceparent (not W3C shaped) yields null", () => {
    expect(parseTraceparent("invalid")).toBeNull();
  });

  test("AC13 boundary: a traceparent with the wrong number of segments yields null", () => {
    expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331")).toBeNull();
  });

  test("AC13 boundary: a traceparent with a wrong-length trace id yields null", () => {
    expect(parseTraceparent("00-0af7651916cd43dd8448eb211c8031-b7ad6b7169203331-01")).toBeNull();
  });

  test("AC13 boundary: a traceparent with a wrong-length parent id yields null", () => {
    expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b716920333-01")).toBeNull();
  });

  test("AC13 boundary: a traceparent with non-hex characters yields null", () => {
    expect(parseTraceparent("00-zzf7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toBeNull();
  });

  test("AC14: a traceparent whose trace id is all zeros yields null", () => {
    expect(parseTraceparent("00-00000000000000000000000000000000-b7ad6b7169203331-01")).toBeNull();
  });

  test("AC14 boundary: an all-zero trace id is rejected even with a non-zero parent id and flags", () => {
    expect(parseTraceparent("00-00000000000000000000000000000000-0000000000000001-01")).toBeNull();
  });

  test("boundary: an undefined value yields null", () => {
    expect(parseTraceparent(undefined)).toBeNull();
  });

  test("boundary: an empty string yields null", () => {
    expect(parseTraceparent("")).toBeNull();
  });
});
