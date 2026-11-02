/**
 * A scripted `MemoryProvider` for the memory suites: reachable, push and pull
 * are `bun:test` mocks, so a test both controls what each call answers and reads
 * back what was asked (`provider.push.mock.calls`).
 *
 * Each method takes a script: the outcomes in call order, and once the script is
 * exhausted its last outcome repeats — so `reachable: false` is false for every
 * call, and a scripted page keeps being returned. An outcome is a value, an
 * `Error` to throw, `"hang"` for a promise that never settles (the timeout tests
 * drive that with a fake clock) or a function computing the value from the call's
 * own argument. `"hang"` is first in the union on purpose: a timeout test needs
 * a call that never answers, and no value a provider returns is that string.
 */
import { type Mock, mock } from "bun:test";
import type { MemoryPage, MemoryProvider, MemoryPushResult, MemoryWriteRequest } from "#src/memory/index";

/** The input each provider method takes. */
type PushInput = Parameters<MemoryProvider["push"]>[0];
type PullInput = Parameters<MemoryProvider["pull"]>[0];

/** One scripted outcome: a value, a thrown error, a call that never settles, or a function of the argument. */
export type ProviderStep<T, A> = T | Error | "hang" | ((arg: A) => T | Promise<T>);

/** The id of a provider nobody named. */
const SCRIPTED_ID = "scripted";

/** What a scripted provider is told to answer, per method. */
export interface MemoryProviderScript {
  /** The provider id; default `"scripted"`. */
  readonly id?: string;
  /** `reachable()` outcomes, one per call; default `true`. */
  readonly reachable?: ProviderStep<boolean, void> | readonly ProviderStep<boolean, void>[];
  /** `push()` outcomes, one per call; default the built-in provider's shape of answer. */
  readonly push?: ProviderStep<MemoryPushResult, PushInput> | readonly ProviderStep<MemoryPushResult, PushInput>[];
  /** `pull()` outcomes, one per call; default one empty finished page. */
  readonly pull?: ProviderStep<MemoryPage, PullInput> | readonly ProviderStep<MemoryPage, PullInput>[];
}

/** A provider whose three methods are mocks: scripted through {@link MemoryProviderScript}, recording every call. */
export type MemoryProviderMock = MemoryProvider & {
  readonly reachable: Mock<MemoryProvider["reachable"]>;
  readonly push: Mock<MemoryProvider["push"]>;
  readonly pull: Mock<MemoryProvider["pull"]>;
};

function isStepFn<T, A>(step: unknown): step is (arg: A) => T | Promise<T> {
  return typeof step === "function";
}

function isStepList<T, A>(script: unknown): script is readonly ProviderStep<T, A>[] {
  return Array.isArray(script);
}

/** One method's script as the list it is consumed from: a lone outcome is a one-outcome list. */
function stepsOf<T, A>(
  script: ProviderStep<T, A> | readonly ProviderStep<T, A>[] | undefined,
  fallback: ProviderStep<T, A>,
): readonly ProviderStep<T, A>[] {
  if (script === undefined) return [fallback];
  if (isStepList<T, A>(script)) return script.length === 0 ? [fallback] : script;
  return [script];
}

/** The steps in call order, each handed out once and the last one repeated. */
function scriptedCalls<T, A>(steps: readonly ProviderStep<T, A>[]): { next(): ProviderStep<T, A> } {
  let calls = 0;
  return {
    next: () => {
      const step = steps[Math.min(calls, steps.length - 1)];
      calls += 1;
      return step;
    },
  };
}

/** One scripted outcome as the promise the method returns. */
async function outcomeOf<T, A>(step: ProviderStep<T, A>, arg: A): Promise<T> {
  if (step === "hang") return await new Promise<T>(() => undefined);
  if (step instanceof Error) throw step;
  if (isStepFn<T, A>(step)) return await step(arg);
  return step;
}

/** What a push nobody scripted answers: the note's own id (or the write's client id) and the mode's status. */
function defaultPushResult(request: MemoryWriteRequest): MemoryPushResult {
  const id = request.note?.id ?? request.clientId;
  const direct = request.writeMode === "direct";
  if (request.kind === "forget") return { id, status: direct ? "deleted" : "pending" };
  return { id, status: direct ? "active" : "pending" };
}

/** The page a pull nobody scripted answers: there is nothing to pull. */
const EMPTY_PAGE: MemoryPage = { notes: [], done: true };

export function makeMemoryProvider(script: MemoryProviderScript = {}): MemoryProviderMock {
  const reachable = scriptedCalls(stepsOf(script.reachable, true));
  const pushed = scriptedCalls(stepsOf(script.push, defaultPushResult));
  const pulled = scriptedCalls(stepsOf(script.pull, EMPTY_PAGE));
  return {
    id: script.id ?? SCRIPTED_ID,
    reachable: mock<MemoryProvider["reachable"]>(async () => await outcomeOf(reachable.next(), undefined)),
    push: mock<MemoryProvider["push"]>(async (request) => await outcomeOf(pushed.next(), request)),
    pull: mock<MemoryProvider["pull"]>(async (input) => await outcomeOf(pulled.next(), input)),
  };
}
