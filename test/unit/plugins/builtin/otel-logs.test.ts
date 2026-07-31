import { describe, expect, test } from "bun:test";
import type { LogEntry } from "@/logger/types";
import { buildLogsPayload, toLogRecord } from "@/plugins";

const baseEntry: LogEntry = {
  timestamp: "2025-01-01T00:00:00.000Z",
  level: "info",
  stage: "routing",
  message: "hello",
};

describe("toLogRecord", () => {
  test("AC1: known ISO-8601 timestamp converts to nanoseconds as a string", () => {
    const record = toLogRecord({
      timestamp: "2025-01-01T00:00:00.123Z",
      level: "info",
      stage: "x",
      message: "m",
    });
    expect(record.timeUnixNano).toBe("1735689600123000000");
  });

  test("AC2: level error maps to severityNumber 17", () => {
    const record = toLogRecord({ ...baseEntry, level: "error" });
    expect(record.severityNumber).toBe(17);
  });

  test("AC3: level error maps to severityText ERROR", () => {
    const record = toLogRecord({ ...baseEntry, level: "error" });
    expect(record.severityText).toBe("ERROR");
  });

  test("AC4: level warn maps to severityNumber 13", () => {
    const record = toLogRecord({ ...baseEntry, level: "warn" });
    expect(record.severityNumber).toBe(13);
  });

  test("AC5: level info maps to severityNumber 9", () => {
    const record = toLogRecord({ ...baseEntry, level: "info" });
    expect(record.severityNumber).toBe(9);
  });

  test("AC6: level debug maps to severityNumber 5", () => {
    const record = toLogRecord({ ...baseEntry, level: "debug" });
    expect(record.severityNumber).toBe(5);
  });

  test("AC7: message maps to body.stringValue", () => {
    const record = toLogRecord({ ...baseEntry, message: "the message" });
    expect(record.body).toEqual({ stringValue: "the message" });
  });

  test("AC8: stage is exposed as nax.stage attribute", () => {
    const record = toLogRecord({ ...baseEntry, stage: "routing" });
    expect(record.attributes).toContainEqual({ key: "nax.stage", value: { stringValue: "routing" } });
  });

  test("AC9: storyId is exposed as nax.story_id attribute when present", () => {
    const record = toLogRecord({ ...baseEntry, storyId: "s-42" });
    expect(record.attributes).toContainEqual({ key: "nax.story_id", value: { stringValue: "s-42" } });
  });

  test("AC10: nax.story_id attribute is absent when storyId is missing", () => {
    const record = toLogRecord(baseEntry);
    expect(record.attributes.some((a) => a.key === "nax.story_id")).toBe(false);
  });

  test("AC11: sessionRole is exposed as nax.session_role attribute when present", () => {
    const record = toLogRecord({ ...baseEntry, sessionRole: "reviewer-semantic" });
    expect(record.attributes).toContainEqual({
      key: "nax.session_role",
      value: { stringValue: "reviewer-semantic" },
    });
  });

  test("AC12: top-level string data becomes nax.data.<key> string attribute", () => {
    const record = toLogRecord({ ...baseEntry, data: { phase: "planning" } });
    expect(record.attributes).toContainEqual({ key: "nax.data.phase", value: { stringValue: "planning" } });
  });

  test("AC13: top-level number data becomes numeric nax.data.<key> attribute", () => {
    const record = toLogRecord({ ...baseEntry, data: { count: 7 } });
    expect(record.attributes).toContainEqual({ key: "nax.data.count", value: { doubleValue: 7 } });
  });

  test("boundary: top-level boolean data stringifies into nax.data.<key>", () => {
    const record = toLogRecord({ ...baseEntry, data: { ok: true, retry: false } });
    expect(record.attributes).toContainEqual({ key: "nax.data.ok", value: { stringValue: "true" } });
    expect(record.attributes).toContainEqual({ key: "nax.data.retry", value: { stringValue: "false" } });
  });

  test("boundary: non-finite numbers are funneled into nax.data_json, not embedded as NaN", () => {
    const record = toLogRecord({ ...baseEntry, data: { ratio: Number.NaN, big: Number.POSITIVE_INFINITY } });
    expect(record.attributes.some((a) => a.key === "nax.data.ratio")).toBe(false);
    expect(record.attributes.some((a) => a.key === "nax.data.big")).toBe(false);
    const dataJson = record.attributes.find((a) => a.key === "nax.data_json");
    expect(dataJson?.value.stringValue).toContain("ratio");
    expect(dataJson?.value.stringValue).toContain("big");
  });

  test("AC14: nested data values are serialized into nax.data_json", () => {
    const record = toLogRecord({
      ...baseEntry,
      data: { findings: [{ rule: "x" }] },
    });
    const dataJson = record.attributes.find((a) => a.key === "nax.data_json");
    expect(dataJson).toBeDefined();
    expect(typeof dataJson?.value.stringValue).toBe("string");
    const parsed = JSON.parse(dataJson?.value.stringValue ?? "{}") as { findings: { rule: string }[] };
    expect(parsed.findings).toEqual([{ rule: "x" }]);
  });

  test("AC15: nax.data_json is truncated to 2048 characters with a trailing marker", () => {
    const long = "x".repeat(5000);
    const record = toLogRecord({ ...baseEntry, data: { blob: { content: long } } });
    const dataJson = record.attributes.find((a) => a.key === "nax.data_json");
    expect(dataJson).toBeDefined();
    expect(dataJson?.value.stringValue).not.toBeNull();
    const value = dataJson?.value.stringValue ?? "";
    expect(value.length).toBeLessThanOrEqual(2048);
    expect(value.endsWith("...[truncated]")).toBe(true);
  });
});

describe("buildLogsPayload", () => {
  test("returns an OTLP resourceLogs envelope with shared resource attributes", () => {
    const entry: LogEntry = { ...baseEntry, storyId: "s-1", data: { phase: "execute" } };
    // biome-ignore lint/suspicious/noExplicitAny: inspecting untyped payload
    const payload: any = buildLogsPayload([entry], {
      serviceName: "nax",
      runId: "r1",
      feature: "feat",
    });
    const scopeLogs = payload.resourceLogs[0].scopeLogs[0];
    expect(scopeLogs.scope.name).toBe("nax");
    expect(scopeLogs.logRecords).toHaveLength(1);
    const resourceAttrs = payload.resourceLogs[0].resource.attributes as { key: string }[];
    expect(resourceAttrs).toContainEqual(expect.objectContaining({ key: "service.name" }));
    expect(resourceAttrs).toContainEqual(expect.objectContaining({ key: "nax.run_id" }));
  });

  test("each log entry becomes one record carrying its attributes", () => {
    const entries: LogEntry[] = [
      { ...baseEntry, message: "first" },
      { ...baseEntry, message: "second", level: "warn" },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: inspecting untyped payload
    const payload: any = buildLogsPayload(entries, { serviceName: "nax", runId: "r1" });
    const records = payload.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(2);
    expect(records[0].body.stringValue).toBe("first");
    expect(records[1].body.stringValue).toBe("second");
    expect(records[1].severityNumber).toBe(13);
  });
});
