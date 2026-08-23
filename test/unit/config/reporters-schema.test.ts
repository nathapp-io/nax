import { describe, expect, test } from "bun:test";
import { ReportersConfigSchema } from "@/config/schemas-reporters";

describe("ReportersConfigSchema", () => {
  test("defaults both reporters to disabled with 5000ms timeout", () => {
    const parsed = ReportersConfigSchema.parse({});
    expect(parsed.webhook.enabled).toBe(false);
    expect(parsed.otel.enabled).toBe(false);
    expect(parsed.webhook.timeoutMs).toBe(5000);
    expect(parsed.otel.timeoutMs).toBe(5000);
    expect(parsed.otel.serviceName).toBe("nax");
    expect(parsed.webhook.headers).toEqual({});
  });

  test("accepts webhook config with url, headers, and event filter", () => {
    const parsed = ReportersConfigSchema.parse({
      webhook: {
        enabled: true,
        url: "https://example.com/hook",
        headers: { Authorization: "Bearer ${TOKEN}" },
        events: ["onRunEnd"],
      },
    });
    expect(parsed.webhook.enabled).toBe(true);
    expect(parsed.webhook.url).toBe("https://example.com/hook");
    expect(parsed.webhook.events).toEqual(["onRunEnd"]);
  });

  test("AC6-11: defaults OTel phase telemetry settings", () => {
    const parsed = ReportersConfigSchema.parse({});

    expect(parsed.otel.detail).toBe("counts");
    expect(parsed.otel.heartbeatIntervalMs).toBe(10_000);
    expect(parsed.otel.maxBatchSize).toBe(64);
    expect(parsed.otel.flushIntervalMs).toBe(5_000);
    expect(parsed.otel.maxQueueSize).toBe(2_048);
    expect(parsed.otel.phases).toBeUndefined();
  });

  test("AC12: rejects trace OTel detail", () => {
    const parsed = ReportersConfigSchema.safeParse({ otel: { detail: "trace" } });

    expect(parsed.success).toBe(false);
  });

  test("AC13: retains onPhaseComplete webhook event", () => {
    const parsed = ReportersConfigSchema.parse({ webhook: { events: ["onPhaseComplete"] } });

    expect(parsed.webhook.events).toEqual(["onPhaseComplete"]);
  });

  test("rejects an unknown event name", () => {
    const res = ReportersConfigSchema.safeParse({
      webhook: { events: ["onSomething"] },
    });
    expect(res.success).toBe(false);
  });

  test("rejects a non-URL webhook url", () => {
    const res = ReportersConfigSchema.safeParse({ webhook: { url: "not-a-url" } });
    expect(res.success).toBe(false);
  });
});

describe("US-005 AC2: OtelReporterConfigSchema defaults logs.enabled to false", () => {
  test("success: when logs is omitted, parsed config reports logs.enabled === false", () => {
    const parsed = ReportersConfigSchema.parse({ otel: { enabled: true } });
    expect((parsed.otel as any).logs?.enabled).toBe(false);
  });

  test("boundary: when logs is omitted entirely, the value is still false (not undefined)", () => {
    const parsed = ReportersConfigSchema.parse({});
    expect((parsed.otel as any).logs).toBeDefined();
    expect((parsed.otel as any).logs?.enabled).toBe(false);
  });
});

describe('US-005 AC3: OtelReporterConfigSchema defaults logs.level to "info"', () => {
  test('success: when logs is omitted, parsed config reports logs.level === "info"', () => {
    const parsed = ReportersConfigSchema.parse({ otel: { enabled: true } });
    expect((parsed.otel as any).logs?.level).toBe("info");
  });

  test("boundary: an explicit level overrides the default", () => {
    const parsed = ReportersConfigSchema.parse({
      otel: { enabled: true, logs: { enabled: true, level: "warn" } },
    });
    expect((parsed.otel as any).logs?.level).toBe("warn");
  });
});
