import { buildAllowedEnv } from "../agents/shared/env";

export function parseCommandToArgv(command: string): string[] {
  const safeEnv = buildAllowedEnv();
  const home = (safeEnv.HOME as string | undefined) ?? "";
  const args: string[] = [];
  let current = "";
  let index = 0;
  const trimmed = command.trim();

  while (index < trimmed.length) {
    const char = trimmed[index];

    if (char === " " || char === "\t") {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      index += 1;
      continue;
    }

    if (char === "'") {
      index += 1;
      while (index < trimmed.length && trimmed[index] !== "'") {
        current += trimmed[index];
        index += 1;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      index += 1;
      while (index < trimmed.length && trimmed[index] !== '"') {
        if (
          trimmed[index] === "\\" &&
          index + 1 < trimmed.length &&
          (trimmed[index + 1] === '"' || trimmed[index + 1] === "\\")
        ) {
          current += trimmed[index + 1];
          index += 2;
          continue;
        }
        current += trimmed[index];
        index += 1;
      }
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args.map((token) => (token.startsWith("~/") && home ? home + token.slice(1) : token));
}
