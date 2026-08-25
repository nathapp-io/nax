import type { PhaseCompleteEvent } from "@/plugins/types";
import { newSpanId } from "./ids";
import {
  attr,
  buildCounterPoint,
  buildHistogramPoint,
  buildResourceAttributes,
  type KeyValue,
  type SpanEvent,
} from "./otlp";

/** Fixed bucket boundaries for the `nax.phase.duration` histogram, in milliseconds. */
export const PHASE_DURATION_BOUNDS = [100, 500, 1000, 5000, 15000, 60000, 300000, 900000];

/** Fixed bucket boundaries for the `nax.phase.cost_usd` histogram, in USD. */
export const PHASE_COST_BOUNDS = [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5];

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  /** Span events (e.g. review findings) — set post-construction when present (US-008). */
  events?: SpanEvent[];
}

export interface PhaseSpanInput {
  event: PhaseCompleteEvent;
  traceId: string;
  startUnixNano: string;
  endUnixNano: string;
}

export interface SpanTree {
  readonly traceId: string;
  readonly runSpanId: string;
  /** Returns the `nax.story` span id for a story, creating one on first reference. */
  storySpanId(storyId: string): string;
  /** Build a `nax.story` span parented directly to the run span. */
  buildStorySpan(storyId: string, startUnixNano: string, endUnixNano: string): Span;
  /** Build a `nax.phase` span parented to its story span (scope "story") or the run span (scope "run"). */
  buildPhaseSpan(input: PhaseSpanInput): Span;
}

/** Tracks `nax.run` -> `nax.story` -> `nax.phase` span parentage for one run's trace. */
export function createSpanTree(traceId: string, runSpanId: string): SpanTree {
  const storySpanIds = new Map<string, string>();

  function storySpanId(storyId: string): string {
    let spanId = storySpanIds.get(storyId);
    if (!spanId) {
      spanId = newSpanId();
      storySpanIds.set(storyId, spanId);
    }
    return spanId;
  }

  function buildStorySpan(storyId: string, startUnixNano: string, endUnixNano: string): Span {
    return {
      traceId,
      spanId: storySpanId(storyId),
      parentSpanId: runSpanId,
      name: "nax.story",
      startTimeUnixNano: startUnixNano,
      endTimeUnixNano: endUnixNano,
      attributes: [attr("nax.story_id", storyId)],
    };
  }

  function buildPhaseSpan({ event, traceId: spanTraceId, startUnixNano, endUnixNano }: PhaseSpanInput): Span {
    const parentSpanId =
      event.scope === "story" && event.storyId !== undefined ? storySpanId(event.storyId) : runSpanId;
    const attributes = [attr("phase", event.phase), attr("outcome", event.outcome)];
    if (event.testStrategy) attributes.push(attr("nax.test_strategy", event.testStrategy));
    return {
      traceId: spanTraceId,
      spanId: newSpanId(),
      parentSpanId,
      name: "nax.phase",
      startTimeUnixNano: startUnixNano,
      endTimeUnixNano: endUnixNano,
      attributes,
    };
  }

  return { traceId, runSpanId, storySpanId, buildStorySpan, buildPhaseSpan };
}

interface PhaseGroup {
  attributes: KeyValue[];
  durations: number[];
  costs: number[];
}

interface CounterGroup {
  attributes: KeyValue[];
  count: number;
}

function counterKey(attributes: KeyValue[]): string {
  return attributes.map((a) => `${a.key}=${a.value.stringValue ?? a.value.doubleValue}`).join("|");
}

function bumpCounter(groups: Map<string, CounterGroup>, attributes: KeyValue[], count: number): void {
  const key = counterKey(attributes);
  const existing = groups.get(key);
  if (existing) {
    existing.count += count;
  } else {
    groups.set(key, { attributes, count });
  }
}

export interface PhaseMetricsAggregator {
  /** Record a `story:phase:completed` / run-scope phase completion into the duration + cost histograms. */
  recordPhase(event: PhaseCompleteEvent): void;
  /** Record review findings for `nax.review.findings`, tagged with `severity`. */
  recordReviewFindings(phase: string, severity: string, count: number): void;
  /** Record rectification iterations for `nax.fix.iterations`, tagged with `strategy`. */
  recordFixIterations(phase: string, strategy: string, count: number): void;
  /** Record a `story:escalated` event for `nax.escalations`, tagged with `to_tier`. */
  recordEscalation(toTier: string, count: number): void;
  /** Build the OTLP ResourceMetrics payload for everything recorded so far. */
  buildMetricsPayload(input: AggregatorMetricsInput): object;
}

export interface AggregatorMetricsInput {
  serviceName: string;
  runId: string;
  timeUnixNano: string;
  feature?: string;
  project?: string;
  gitBranch?: string;
  gitSha?: string;
}

/** Accumulates phase telemetry into bounded-cardinality OTLP metric data points. */
export function createPhaseMetricsAggregator(): PhaseMetricsAggregator {
  const phaseGroups = new Map<string, PhaseGroup>();
  const reviewFindings = new Map<string, CounterGroup>();
  const fixIterations = new Map<string, CounterGroup>();
  const escalations = new Map<string, CounterGroup>();

  function recordPhase(event: PhaseCompleteEvent): void {
    const attributes = [
      attr("phase", event.phase),
      attr("outcome", event.outcome),
      attr("tier", event.tier ?? "unknown"),
      attr("test_strategy", event.testStrategy ?? "unknown"),
      attr("session_model", event.sessionModel ?? "unknown"),
    ];
    const key = counterKey(attributes);
    let group = phaseGroups.get(key);
    if (!group) {
      group = { attributes, durations: [], costs: [] };
      phaseGroups.set(key, group);
    }
    group.durations.push(event.durationMs);
    // Absent (not fabricated 0) for run-scope completions whose cost genuinely
    // wasn't measured (US-004 Out of Scope) — omit rather than misreport.
    if (event.costUsd !== undefined) group.costs.push(event.costUsd);
  }

  function recordReviewFindings(phase: string, severity: string, count: number): void {
    bumpCounter(reviewFindings, [attr("phase", phase), attr("severity", severity)], count);
  }

  function recordFixIterations(phase: string, strategy: string, count: number): void {
    bumpCounter(fixIterations, [attr("phase", phase), attr("strategy", strategy)], count);
  }

  function recordEscalation(toTier: string, count: number): void {
    bumpCounter(escalations, [attr("to_tier", toTier)], count);
  }

  function buildMetricsPayload(input: AggregatorMetricsInput): object {
    const { serviceName, runId, timeUnixNano, feature, project, gitBranch, gitSha } = input;
    const groups = [...phaseGroups.values()];
    const counterMetric = (name: string, source: Map<string, CounterGroup>) => ({
      name,
      sum: {
        aggregationTemporality: 2, // CUMULATIVE
        isMonotonic: true,
        dataPoints: [...source.values()].map((g) => buildCounterPoint(g.count, g.attributes, timeUnixNano)),
      },
    });
    const metrics: object[] = [];
    if (groups.length > 0) {
      metrics.push({
        name: "nax.phase.duration",
        histogram: {
          aggregationTemporality: 2,
          dataPoints: groups.map((g) =>
            buildHistogramPoint(g.durations, PHASE_DURATION_BOUNDS, g.attributes, timeUnixNano),
          ),
        },
      });
      metrics.push({
        name: "nax.phase.cost_usd",
        histogram: {
          aggregationTemporality: 2,
          dataPoints: groups.map((g) => buildHistogramPoint(g.costs, PHASE_COST_BOUNDS, g.attributes, timeUnixNano)),
        },
      });
    }
    if (reviewFindings.size > 0) metrics.push(counterMetric("nax.review.findings", reviewFindings));
    if (fixIterations.size > 0) metrics.push(counterMetric("nax.fix.iterations", fixIterations));
    if (escalations.size > 0) metrics.push(counterMetric("nax.escalations", escalations));

    return {
      resourceMetrics: [
        {
          resource: {
            attributes: buildResourceAttributes({
              serviceName,
              runId,
              feature,
              project,
              git: { branch: gitBranch, sha: gitSha },
            }),
          },
          scopeMetrics: [{ scope: { name: "nax" }, metrics }],
        },
      ],
    };
  }

  return { recordPhase, recordReviewFindings, recordFixIterations, recordEscalation, buildMetricsPayload };
}
