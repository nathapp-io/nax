/**
 * Set environment variables for the duration of one test body.
 *
 * `process.env` is process-wide, so a test that sets a variable and does not
 * restore it leaks into every later test in the same Bun process (including other
 * files in a merged coverage run). `withEnvVars` restores each touched name —
 * including the ones that were absent before — whether `fn` resolves or throws.
 *
 * ```ts
 * await withEnvVars({ NAX_TELEGRAM_TOKEN: "t" }, async () => {
 *   expect(buildAcpChatEnv("claude")).not.toHaveProperty("NAX_TELEGRAM_TOKEN");
 * });
 * ```
 */
export async function withEnvVars<T>(
  vars: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
