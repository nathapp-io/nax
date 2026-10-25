import { Text, useInput } from "ink";
import { type ReactElement, useRef, useState } from "react";

export interface InputBoxProps {
  busy: boolean;
  /** Disabled by the future ask UI while it owns keyboard input. */
  active?: boolean;
  onSubmit(message: string): void;
}

export function InputBox({ busy, active = true, onSubmit }: InputBoxProps): ReactElement {
  const [value, setValue] = useState("");
  const draft = useRef("");
  const update = (next: string) => {
    draft.current = next;
    setValue(next);
  };
  useInput(
    (input, key) => {
      if (key.return) {
        if (key.meta) update(`${draft.current}\n`);
        else if (!busy && draft.current.trim()) {
          const message = draft.current;
          update("");
          onSubmit(message);
        }
      } else if (key.backspace || key.delete) update(Array.from(draft.current).slice(0, -1).join(""));
      else if (
        !key.ctrl &&
        !key.meta &&
        !key.escape &&
        !key.tab &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow
      ) {
        update(draft.current + input);
      }
    },
    { isActive: active },
  );
  return <Text>{`> ${value}`}</Text>;
}
