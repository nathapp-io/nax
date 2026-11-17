/** Width-aware surface demand, before the frame allocator applies height pressure. */
import type { ChatPendingAsk } from "@/chat";
import { measureAskCard } from "./AskCard";
import type { AskCardModel } from "./ask-card";
import { type InputDraft, type InputRowsOptions, measureInput } from "./ChatInput";
import type { ChatFrameOptions } from "./frame-layout";
import { measurePicker, type PickerModel } from "./Picker";
import type { ChatTheme } from "./theme";

interface FrameSurfacesOptions {
  readonly draft: InputDraft;
  readonly input: InputRowsOptions;
  readonly ask?: ChatPendingAsk;
  readonly askModel?: AskCardModel;
  readonly answer: InputDraft;
  readonly picker?: PickerModel;
  readonly theme: ChatTheme;
}

export function measureFrameSurfaces(
  options: FrameSurfacesOptions,
): Pick<ChatFrameOptions, "input" | "ask" | "picker"> {
  const { draft, input, ask, askModel, answer, picker, theme } = options;
  return {
    input: measureInput(draft, input),
    ask:
      ask === undefined || askModel === undefined
        ? undefined
        : measureAskCard(askModel, {
            width: input.width,
            theme,
            answer,
            expiresAt: ask.expiresAt,
          }),
    picker: picker === undefined ? undefined : measurePicker(picker),
  };
}
