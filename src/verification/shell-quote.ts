/** POSIX single-quote a shell argument so it survives `/bin/sh -c`. */
export function shellQuoteArg(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}
