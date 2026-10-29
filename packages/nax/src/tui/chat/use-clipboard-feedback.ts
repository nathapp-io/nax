import { useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import type { FooterHint } from "./chat-status";
import { copyToClipboard } from "./clipboard";
import type { MouseEvents } from "./mouse-input";

/**
 * The gesture the footer offers, in precedence order: an armed quit, then an armed clear,
 * then a running turn (with a background key when available), then expanded detail, then idle.
 * Only one is ever shown, so
 * the warning-coloured quit hint is never hidden behind something the screen is merely doing.
 */
export function footerHint(input: {
  quitArmed: boolean;
  clearArmed: boolean;
  busy: boolean;
  expanded: boolean;
  backgroundable: boolean;
  tmux: boolean;
}): FooterHint {
  if (input.quitArmed) return "quit";
  if (input.clearArmed) return "clear";
  if (input.busy && input.backgroundable) return input.tmux ? "backgroundTmux" : "background";
  if (input.busy) return "busy";
  if (input.expanded) return "expanded";
  return "idle";
}

/** Copy feedback is immediate and cannot be resurrected by a late pbcopy result. */
export function useClipboardFeedback(mouse?: MouseEvents): {
  copiedChars: number | undefined;
  onCopy: (text: string) => void;
} {
  const [copiedChars, setCopiedChars] = useState<number>();
  useInput(() => setCopiedChars(undefined));
  useEffect(
    () =>
      mouse?.subscribe((event) => {
        if (event.kind === "press") setCopiedChars(undefined);
      }),
    [mouse],
  );
  const onCopy = useCallback((text: string) => {
    void copyToClipboard(text);
    setCopiedChars(text.length);
  }, []);
  return { copiedChars, onCopy };
}
