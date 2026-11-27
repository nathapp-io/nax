/**
 * The choice card — a session question that carries a question set, drawn as a budgeted
 * interactive card (US-005).
 *
 * The card owns everything an ordinary question hands to a text box. It holds the
 * `ChoiceState` locally, exactly as the approval card holds its own selection, normalises
 * ink's `(input, key)` into the `ChoiceKey` the pure reducer (`choice-question.ts`) takes, and
 * draws the rows `choiceQuestionLayout` decided. Nothing here decides a row: the layout does,
 * so the measurement the screen reserves and the rows on screen cannot disagree.
 *
 * Submitting goes through the controller's `answerChoices`, whose `text` is
 * `formatChoiceAnswers` over the ask's **original** questions — the labels the asker wrote,
 * not the sanitised copy the card drew — so a session reads its own words back. The controller
 * answers before it removes the ask, so a session that refuses the answer throws with the ask
 * still pending; that refusal (`AGENT_SESSION_INVALID_ANSWER`) is logged at warn and the card
 * stays open, because a throw out of an input handler would take the whole screen down.
 *
 * Escape declines: the card calls its `onDismiss` prop, which is the same path the text card's
 * escape takes, and the screen owns the two-press confirmation, the decline and the turn
 * cancel that follow.
 */
import { type ChoiceAnswer, type ChoiceQuestion, formatChoiceAnswers } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { Box, type Key, useInput } from "ink";
import { type ReactElement, useEffect, useRef, useState } from "react";
import type { ChatPendingAsk } from "@/chat";
import { getLogger } from "@/logger";
import type { AskCardProps } from "./AskCard";
import type { AskCardChoiceQuestion } from "./ask-card";
import { type ChoiceKey, type ChoiceState, initialChoiceState, reduceChoiceKey } from "./choice-question";
import { choiceQuestionLayout } from "./choice-question-layout";
import { _askCardDeps, COUNTDOWN_TICK_MS, secondsLeft } from "./countdown";
import { StyledLineView } from "./styled-line";

/** The one error a session raises for an answer it will not take; the card survives it. */
const INVALID_ANSWER = "AGENT_SESSION_INVALID_ANSWER";

/**
 * What the card's props are: the framed card's, with the choice model that drew it. The
 * answer box's draft is carried and ignored — the framed card is the only thing that reads
 * it — so the screen can hand both cards the same props.
 */
export type ChoiceQuestionCardProps = Omit<AskCardProps, "model"> & { readonly model: AskCardChoiceQuestion };

/**
 * One ink keypress as the reducer's key, or undefined when the card does not answer to it. A
 * lone escape arrives as `escape` **and** `meta`, so it is taken first; a ctrl or meta chord is
 * never a character the person typed; and a shifted arrow stays the transcript's, as it is on
 * every other card.
 */
export function choiceKey(input: string, key: Key): ChoiceKey | undefined {
  if (key.escape) return { kind: "escape" };
  if (key.shift) return undefined;
  if (key.upArrow) return { kind: "up" };
  if (key.downArrow) return { kind: "down" };
  if (key.leftArrow) return { kind: "left" };
  if (key.rightArrow) return { kind: "right" };
  if (key.return) return { kind: "return" };
  if (key.backspace || key.delete) return { kind: "backspace" };
  if (key.ctrl || key.meta || key.tab) return undefined;
  if (input === " ") return { kind: "space" };
  return input === "" ? undefined : { kind: "char", char: input };
}

/** Whether an error is the session refusing an answer it will not take. */
function isInvalidAnswer(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === INVALID_ANSWER;
}

/** The question set the session raised, before the card sanitised its copy for drawing. */
function originalQuestions(ask: ChatPendingAsk, model: AskCardChoiceQuestion): readonly ChoiceQuestion[] {
  return ask.type === "question" && ask.questions !== undefined ? ask.questions : model.questions;
}

export function ChoiceQuestionCard({
  ask,
  model,
  controller,
  width,
  budget,
  theme,
  onDismiss,
  active = true,
}: ChoiceQuestionCardProps): ReactElement {
  const [state, setState] = useState<ChoiceState>(() => initialChoiceState(model.questions));
  const [nowMs, setNowMs] = useState<number>(() => _askCardDeps.now());
  /**
   * The newest state, ahead of the card's re-render. Two keys delivered in one batch both run
   * before React re-renders, so reducing the `state` value would make the second key discard
   * the first one's move — and a return in that batch would submit a selection the card no
   * longer shows.
   */
  const latest = useRef(state);

  // The countdown's clock: a `setTimeout` chain, cancelled on unmount and once nothing is
  // left to count. `setInterval` cannot be stopped by the cleanup before its next tick fires.
  useEffect(() => {
    let handle: ReturnType<typeof _askCardDeps.setTimeout> | undefined;
    let live = true;
    const tick = (): void => {
      const now = _askCardDeps.now();
      setNowMs(now);
      if (!live || secondsLeft(ask.expiresAt, now) === 0) return;
      handle = _askCardDeps.setTimeout(tick, COUNTDOWN_TICK_MS);
    };
    if (secondsLeft(ask.expiresAt, _askCardDeps.now()) > 0) handle = _askCardDeps.setTimeout(tick, COUNTDOWN_TICK_MS);
    return () => {
      live = false;
      if (handle !== undefined) _askCardDeps.clearTimeout(handle);
    };
  }, [ask.expiresAt]);

  /** Hand the answers to the session, in the asker's own labels, and keep the card open on a refusal. */
  const submit = (answers: readonly ChoiceAnswer[]): void => {
    const text = formatChoiceAnswers(originalQuestions(ask, model), answers);
    try {
      controller.answerChoices(ask.requestId, answers, text);
    } catch (error) {
      getLogger()?.warn("chat", "Choice card answer refused; keeping the card open", {
        requestId: ask.requestId,
        invalid: isInvalidAnswer(error),
        error: errorMessage(error),
      });
    }
  };

  const reduce = (input: string, key: Key): void => {
    const pressed = choiceKey(input, key);
    if (pressed === undefined) return;
    const reduced = reduceChoiceKey(latest.current, model.questions, pressed);
    latest.current = reduced.state;
    setState(reduced.state);
    const outcome = reduced.outcome;
    if (outcome === undefined) return;
    if (outcome.kind === "decline") {
      onDismiss?.();
      return;
    }
    submit(outcome.answers);
  };

  useInput(reduce, { isActive: active });

  const layout = choiceQuestionLayout(model, state, { width, budget, theme, expiresAt: ask.expiresAt, nowMs });
  return (
    <Box flexDirection="column">
      {layout.head.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the card's rows are positional and redrawn whole.
        <StyledLineView key={`head-${index}`} line={line} theme={theme} />
      ))}
      {layout.middle.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the card's rows are positional and redrawn whole.
        <StyledLineView key={`middle-${index}`} line={line} theme={theme} />
      ))}
      {layout.tail.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the card's rows are positional and redrawn whole.
        <StyledLineView key={`tail-${index}`} line={line} theme={theme} />
      ))}
    </Box>
  );
}
