/**
 * Opening a URL in the user's browser.
 *
 * Best-effort by design: the caller always prints the URL first, so a failure
 * to spawn an opener costs the user a copy-paste rather than the login. That
 * is why nothing here throws and no exit code is inspected — over SSH or in a
 * container there is often no browser to open at all.
 *
 * The URL is passed as its own argv entry, never through a shell, so a crafted
 * redirect cannot become a command.
 */

/** Test seam. */
export const _openUrlDeps: {
  spawn: (command: readonly string[]) => void;
  platform: () => string;
} = {
  spawn: (command: readonly string[]) => {
    Bun.spawn([...command], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  },
  platform: () => process.platform,
};

/** The opener for a platform. Windows needs the empty "" title argument. */
function openerFor(platform: string, url: string): readonly string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

export function openUrl(url: string): void {
  try {
    _openUrlDeps.spawn(openerFor(_openUrlDeps.platform(), url));
  } catch {
    // Deliberately silent: the URL is already on screen and the login is
    // still completable by hand. An error here would be noise, not news.
  }
}
