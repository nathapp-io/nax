/** Raw HTTP to the tool host: what an MCP client never sends (wrong Host, Origin, oversized or invalid bodies). */
import { request } from "node:http";

export interface RawRequest {
  readonly port: number;
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Written in order, then the request ends. Omitted: headers only, and the request stays open. */
  readonly body?: readonly (string | Buffer)[];
}

export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** Resolves on the response; a reset after it (an early refusal of a body still being sent) is ignored. */
export function rawRequest(input: RawRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: input.port,
        method: input.method ?? "POST",
        path: input.path ?? "/mcp",
        headers: { ...input.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
          req.destroy();
        });
      },
    );
    req.on("error", reject);
    if (input.body === undefined) {
      req.flushHeaders();
      return;
    }
    for (const part of input.body) req.write(part);
    req.end();
  });
}
