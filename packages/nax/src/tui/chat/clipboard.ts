/** Injectable terminal and macOS clipboard effects. */
export const _clipboardDeps = {
  write: (text: string): void => {
    process.stdout.write(text);
  },
  platform: process.platform,
  spawnCopy: async (text: string): Promise<number> => {
    const child = Bun.spawn(["pbcopy"], {
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
    });
    return child.exited;
  },
};

export function osc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

export async function copyToClipboard(text: string): Promise<void> {
  _clipboardDeps.write(osc52(text));
  if (_clipboardDeps.platform !== "darwin") return;
  try {
    await _clipboardDeps.spawnCopy(text);
  } catch {
    // Best effort: OSC 52 was already sent; pbcopy may be unavailable.
  }
}
