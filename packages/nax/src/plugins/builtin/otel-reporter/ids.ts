/** Generate `bytes` random bytes as a lowercase hex string. */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let out = "";
  for (const b of arr) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 16-byte (32 hex char) OTLP trace id. */
export const newTraceId = (): string => randomHex(16);

/** 8-byte (16 hex char) OTLP span id. */
export const newSpanId = (): string => randomHex(8);
