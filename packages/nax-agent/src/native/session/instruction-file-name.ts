import { NaxError } from "#src/infra/nax-error";

export const DEFAULT_INSTRUCTION_FILE_NAME = "AGENTS.md";

/** A plain, nonhidden Markdown basename, never a path or URI. */
export function isInstructionFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.startsWith(".") &&
    value.slice(0, -3).trim().length > 0 &&
    /\.md$/i.test(value) &&
    !/[\\/:]/.test(value) &&
    ![...value].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

export function instructionFileNameFor(value: unknown): string {
  if (value === undefined) return DEFAULT_INSTRUCTION_FILE_NAME;
  if (isInstructionFileName(value)) return value;
  throw new NaxError(
    "instructionFileName must be a nonhidden Markdown basename without path separators, colon or control characters",
    "INVALID_INSTRUCTION_FILE_NAME",
    { stage: "native-session" },
  );
}
