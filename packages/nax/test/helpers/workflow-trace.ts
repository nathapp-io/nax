/**
 * G0 (step-graph equivalence): record what a workflow machine does at its injection seams into a
 * comparable trace, normalize the parts that are wall-clock or key-order noise, and hold the result
 * against a committed golden file.
 *
 * The seams are the machine's own — `FeatureEnv.steps`, `FeatureEnv.sink` — plus the run log, so a
 * trace describes behaviour and not implementation: an engine that keeps the seams and the
 * interactions reproduces it byte for byte. Test-only; nothing here is imported by `src/`.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { formatDuration } from "@/log-format";
import { addSink, initLogger, resetLogger } from "@/logger";
import { type FeatureEnv, type FeatureSink, type FeatureSteps, runFeatureMachine } from "@/workflow/feature-machine";
import type { LedgerWriteOptions } from "@/workflow/ledger";
import type { FeatureStep } from "@/workflow/types";

/** Which machine produced a trace. The story loop (US-003) records into the same format. */
export type TraceMachine = "feature" | "story";

/** A call into `steps` or `advisor`. */
export interface TraceCallEvent {
  readonly kind: "call";
  readonly method: string;
  readonly args: readonly unknown[];
}

/** What such a call returned. A call that threw records no return: the throw is the trace's `end`. */
export interface TraceReturnEvent {
  readonly kind: "return";
  readonly method: string;
  readonly value: unknown;
}

/** A `FeatureSink.step` call, without the record it also passes: the record has its own update event. */
export interface TraceStepEvent {
  readonly kind: "step";
  readonly step: FeatureStep;
}

/** A `FeatureSink.update` record (or a `StoryLoopSink.update` patch). */
export interface TraceUpdateEvent {
  readonly kind: "update";
  readonly record: unknown;
}

/** A `FeatureSink.ledger` write. */
export interface TraceLedgerEvent {
  readonly kind: "ledger";
  readonly text: string;
  readonly options?: LedgerWriteOptions | undefined;
}

/** A `FeatureSink.artifact` write. */
export interface TraceArtifactEvent {
  readonly kind: "artifact";
  readonly name: string;
  readonly value: unknown;
}

/** A `stage: "workflow"` run-log line. */
export interface TraceLogEvent {
  readonly kind: "log";
  readonly level: string;
  readonly message: string;
  readonly data?: Record<string, unknown> | undefined;
}

/** One recorded interaction, in the order it happened. */
export type TraceEvent =
  | TraceCallEvent
  | TraceReturnEvent
  | TraceStepEvent
  | TraceUpdateEvent
  | TraceLedgerEvent
  | TraceArtifactEvent
  | TraceLogEvent;

/** How the machine finished. */
export interface TraceEnd {
  readonly returned?: unknown;
  readonly threw?: { readonly code: string | null; readonly message: string };
}

/** A whole recorded scenario. */
export interface WorkflowTrace {
  readonly scenario: string;
  readonly machine: TraceMachine;
  readonly events: readonly TraceEvent[];
  readonly end: TraceEnd;
}

/** What `recordFeatureTrace` needs from a scripted harness: the `FeatureEnv` the machine runs on. */
export interface FeatureTraceHarness {
  readonly env: FeatureEnv;
}

/** Where a trace's golden lives; `root` defaults to `test/fixtures/workflow-equivalence` beside this file. */
export interface GoldenOptions {
  readonly root?: string;
}

/** The run-log stage whose lines a trace keeps; everything else is another module's voice. */
const WORKFLOW_STAGE = "workflow";

/**
 * A deep copy of a plain data value, taken when the interaction was observed. Both machines keep
 * using the objects they hand a seam — a scripted gate result, a findings list, a record patch — so a
 * trace must record what a seam was handed, not what that object later became: mutating an argument,
 * a returned object or a persisted record after capture leaves the recorded event unchanged.
 *
 * The first signature keeps a log line's `data` a `Record<string, unknown>` at its call site; every
 * other payload lands as `unknown` and is narrowed by the event's own type.
 */
export function snapshot(value: Record<string, unknown>): Record<string, unknown>;
export function snapshot(value: unknown): unknown;
export function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => snapshot(item));
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source)) copy[key] = snapshot(source[key]);
  return copy;
}

/**
 * `ledger` is the one seam write whose payload is a flat options object (`LedgerWriteOptions`), so a
 * spread is its whole copy — and it stays typed, unlike `snapshot`, whose result is `unknown`.
 */
export function snapshotOptions(options: LedgerWriteOptions | undefined): LedgerWriteOptions | undefined {
  return options === undefined ? undefined : { ...options };
}

/** A call hook: same signature as the seam method, so wrapping keeps sync versus async. */
export function tracedSync<A extends readonly unknown[], R>(
  method: string,
  fn: (...args: A) => R,
  events: TraceEvent[],
): (...args: A) => R {
  return (...args: A): R => {
    events.push({ kind: "call", method, args: args.map((arg) => snapshot(arg)) });
    const value = fn(...args);
    events.push({ kind: "return", method, value: snapshot(value) });
    return value;
  };
}

export function tracedAsync<A extends readonly unknown[], R>(
  method: string,
  fn: (...args: A) => Promise<R>,
  events: TraceEvent[],
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    events.push({ kind: "call", method, args: args.map((arg) => snapshot(arg)) });
    const value = await fn(...args);
    events.push({ kind: "return", method, value: snapshot(value) });
    return value;
  };
}

/**
 * The seam methods the harness actually provides, wrapped. An optional method it leaves out stays
 * out: the machine branches on whether `modelFor` / `flaggedDecisions` exists at all.
 */
function wrapSteps(steps: FeatureSteps, events: TraceEvent[]): FeatureSteps {
  const modelFor = steps.modelFor;
  const flaggedDecisions = steps.flaggedDecisions;
  return {
    repoGates: tracedAsync("repoGates", steps.repoGates.bind(steps), events),
    branchReview: tracedAsync("branchReview", steps.branchReview.bind(steps), events),
    branchFix: tracedAsync("branchFix", steps.branchFix.bind(steps), events),
    branchReReview: tracedAsync("branchReReview", steps.branchReReview.bind(steps), events),
    adjudicate: tracedAsync("adjudicate", steps.adjudicate.bind(steps), events),
    publish: tracedAsync("publish", steps.publish.bind(steps), events),
    head: tracedAsync("head", steps.head.bind(steps), events),
    changedFiles: tracedAsync("changedFiles", steps.changedFiles.bind(steps), events),
    ...(modelFor ? { modelFor: tracedSync("modelFor", modelFor.bind(steps), events) } : {}),
    ...(flaggedDecisions
      ? { flaggedDecisions: tracedAsync("flaggedDecisions", flaggedDecisions.bind(steps), events) }
      : {}),
  };
}

/** The sink's four writes, recorded before they run so their order is the machine's order. */
function wrapSink(sink: FeatureSink, events: TraceEvent[]): FeatureSink {
  return {
    update: async (record) => {
      events.push({ kind: "update", record: snapshot(record) });
      await sink.update(record);
    },
    ledger: async (text, options) => {
      events.push({ kind: "ledger", text, options: snapshotOptions(options) });
      await sink.ledger(text, options);
    },
    step: (step, record) => {
      events.push({ kind: "step", step });
      sink.step(step, record);
    },
    artifact: async (name, value) => {
      events.push({ kind: "artifact", name, value: snapshot(value) });
      await sink.artifact(name, value);
    },
  };
}

/** `{ threw: { code, message } }` for anything the machine let escape; never rethrown. */
function thrownBy(err: unknown): TraceEnd["threw"] {
  return { code: err instanceof NaxError ? err.code : null, message: errorMessage(err) };
}

/**
 * Runs `runFeatureMachine` on the harness env with both seams and the run log recorded, and resolves
 * with the trace — including when the machine throws, which is recorded in `end`, not rethrown.
 */
export async function recordFeatureTrace(scenario: string, harness: FeatureTraceHarness): Promise<WorkflowTrace> {
  const events: TraceEvent[] = [];
  const env: FeatureEnv = {
    ...harness.env,
    steps: wrapSteps(harness.env.steps, events),
    sink: wrapSink(harness.env.sink, events),
  };
  resetLogger();
  initLogger({ level: "silent" });
  const unsubscribe = addSink((entry) => {
    if (entry.stage !== WORKFLOW_STAGE) return;
    const data = entry.data === undefined ? undefined : snapshot(entry.data);
    events.push({ kind: "log", level: entry.level, message: entry.message, data });
  });
  try {
    const returned = await runFeatureMachine(env);
    // `end` keeps the machine's own value rather than a copy: it is not a recorded interaction (the
    // machine hands it back exactly once, when it is already finished), and AC-10 pins the identity.
    return { scenario, machine: "feature", events, end: { returned } };
  } catch (err) {
    return { scenario, machine: "feature", events, end: { threw: thrownBy(err) } };
  } finally {
    unsubscribe();
    resetLogger();
  }
}

/** The two values G0 does not inject a clock for; both machines read the wall clock instead. */
const TS_PLACEHOLDER = "<ts>";
const DURATION_PLACEHOLDER = "<dur>";
const ENDED_AT_KEY = "endedAt";
const DURATION_MS_KEY = "durationMs";

/** Replaces the trailing duration a step's `done` line carries, and nothing else in the text. */
function withoutDuration(message: string, durationMs: number): string {
  const suffix = formatDuration(durationMs);
  if (!message.endsWith(suffix)) return message;
  return `${message.slice(0, message.length - suffix.length)}${DURATION_PLACEHOLDER}`;
}

function normalizeLog(event: TraceLogEvent): TraceEvent {
  const durationMs = event.data?.[DURATION_MS_KEY];
  if (typeof durationMs !== "number") return normalizeValue(event);
  const data = { ...event.data, [DURATION_MS_KEY]: 0 };
  return normalizeValue({ kind: "log", level: event.level, message: withoutDuration(event.message, durationMs), data });
}

function normalizeEvent(event: TraceEvent): TraceEvent {
  return event.kind === "log" ? normalizeLog(event) : normalizeValue(event);
}

function normalizeValue(value: readonly TraceEvent[]): TraceEvent[];
function normalizeValue(value: TraceEnd): TraceEnd;
function normalizeValue(value: TraceEvent): TraceEvent;
function normalizeValue(value: unknown): unknown;
/**
 * Deep copy with object keys sorted, `undefined` values dropped (exactly as `JSON.stringify` drops
 * them) and every string-valued `endedAt` replaced. Arrays keep their order.
 */
function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    normalized[key] = key === ENDED_AT_KEY && typeof item === "string" ? TS_PLACEHOLDER : normalizeValue(item);
  }
  return normalized;
}

/** The comparison form of a trace: what a golden file holds. */
export function normalizeTrace(trace: WorkflowTrace): WorkflowTrace {
  return {
    scenario: trace.scenario,
    machine: trace.machine,
    events: trace.events.map((event) => normalizeEvent(event)),
    end: normalizeValue(trace.end),
  };
}

/** The regeneration switch: absent (or anything but "1") means compare, never write. */
const GOLDEN_ENV_VAR = "NAX_UPDATE_WORKFLOW_GOLDEN";
/** The committed fixtures root, resolved from this file so the process cwd does not matter. */
const GOLDEN_ROOT = join(import.meta.dir, "..", "fixtures", "workflow-equivalence");

function isTrace(value: unknown): value is WorkflowTrace {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const machine = candidate.machine;
  return (
    typeof candidate.scenario === "string" &&
    (machine === "feature" || machine === "story") &&
    Array.isArray(candidate.events) &&
    typeof candidate.end === "object" &&
    candidate.end !== null
  );
}

function readGolden(text: string, path: string): WorkflowTrace {
  const parsed: unknown = JSON.parse(text);
  if (!isTrace(parsed)) throw new Error(`workflow golden is malformed: ${path}`);
  return normalizeTrace(parsed);
}

/** The index of the first event that differs, or the shorter list's length when one is a prefix. */
function firstDifferingEvent(expected: readonly TraceEvent[], actual: readonly TraceEvent[]): number {
  const shared = Math.min(expected.length, actual.length);
  for (let at = 0; at < shared; at += 1) {
    if (JSON.stringify(expected[at]) !== JSON.stringify(actual[at])) return at;
  }
  return expected.length === actual.length ? -1 : shared;
}

const showEvent = (events: readonly TraceEvent[], at: number): string =>
  at < events.length ? JSON.stringify(events[at]) : "(none)";

function eventMismatch(
  scenario: string,
  at: number,
  expected: readonly TraceEvent[],
  actual: readonly TraceEvent[],
  path: string,
): string {
  return [
    `workflow golden mismatch: scenario "${scenario}" differs at event index ${at} (${path})`,
    `  expected: ${showEvent(expected, at)}`,
    `  actual:   ${showEvent(actual, at)}`,
  ].join("\n");
}

function endMismatch(scenario: string, expected: TraceEnd, actual: TraceEnd, path: string): string {
  return [
    `workflow golden mismatch: scenario "${scenario}": end differs (${path})`,
    `  expected: ${JSON.stringify(expected)}`,
    `  actual:   ${JSON.stringify(actual)}`,
  ].join("\n");
}

/**
 * Holds `trace` against its golden. Missing fails (it never creates the file); only
 * `NAX_UPDATE_WORKFLOW_GOLDEN=1` writes, which is the deliberate regeneration step.
 */
export async function compareWithGolden(trace: WorkflowTrace, options: GoldenOptions = {}): Promise<void> {
  const path = join(options.root ?? GOLDEN_ROOT, trace.machine, `${trace.scenario}.json`);
  const actual = normalizeTrace(trace);
  if (process.env[GOLDEN_ENV_VAR] === "1") {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`golden missing: ${path} (set ${GOLDEN_ENV_VAR}=1 to create it)`);
  }
  const expected = readGolden(await file.text(), path);
  const at = firstDifferingEvent(expected.events, actual.events);
  if (at !== -1) throw new Error(eventMismatch(trace.scenario, at, expected.events, actual.events, path));
  if (JSON.stringify(expected.end) !== JSON.stringify(actual.end)) {
    throw new Error(endMismatch(trace.scenario, expected.end, actual.end, path));
  }
}
