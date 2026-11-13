import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { kodaFlowConnection } from "@/chat/flow";

const url = "https://koda.example/api";
const bearer = "Bearer k";

describe("kodaFlowConnection", () => {
  test("returns the url and headers when memory.koda.url and an Authorization header are configured", () => {
    const config = makeNaxConfig({ memory: { koda: { url, headers: { Authorization: bearer } } } });

    expect(kodaFlowConnection(config)).toEqual({ url, headers: { Authorization: bearer } });
  });

  test("returns undefined when memory.koda.url is unset", () => {
    const config = makeNaxConfig({ memory: { koda: { headers: { Authorization: bearer } } } });

    expect(kodaFlowConnection(config)).toBeUndefined();
  });

  test("returns undefined when the config has no memory.koda block", () => {
    expect(kodaFlowConnection(makeNaxConfig())).toBeUndefined();
  });

  test("returns undefined when memory.koda.url is empty or whitespace", () => {
    for (const empty of ["", "   "]) {
      const config = makeNaxConfig({ memory: { koda: { url: empty, headers: { Authorization: bearer } } } });

      expect(kodaFlowConnection(config)).toBeUndefined();
    }
  });

  test("returns undefined when no header is an authorization header in any letter case", () => {
    for (const headers of [{ "x-api-key": bearer }, { auth: bearer }, { "authorization-extra": bearer }]) {
      const config = makeNaxConfig({ memory: { koda: { url, headers } } });

      expect(kodaFlowConnection(config)).toBeUndefined();
    }
  });

  test("returns undefined when the authorization header value is empty or whitespace", () => {
    for (const value of ["", "   ", "\t\n"]) {
      const config = makeNaxConfig({ memory: { koda: { url, headers: { Authorization: value } } } });

      expect(kodaFlowConnection(config)).toBeUndefined();
    }
  });

  test("returns the connection when the header name is spelled AUTHORIZATION", () => {
    const config = makeNaxConfig({ memory: { koda: { url, headers: { AUTHORIZATION: bearer } } } });

    expect(kodaFlowConnection(config)).toEqual({ url, headers: { AUTHORIZATION: bearer } });
  });

  test("returns the connection when the header name is spelled authorization", () => {
    const config = makeNaxConfig({ memory: { koda: { url, headers: { authorization: bearer } } } });

    expect(kodaFlowConnection(config)).toEqual({ url, headers: { authorization: bearer } });
  });

  test("keeps every configured header, not only the authorization one", () => {
    const headers = { Authorization: bearer, "x-koda-agent": "nax" };
    const config = makeNaxConfig({ memory: { koda: { url, headers } } });

    expect(kodaFlowConnection(config)).toEqual({ url, headers });
  });

  test("returns undefined when a later authorization header is blank, as the client folds it", () => {
    for (const value of ["", "   "]) {
      const config = makeNaxConfig({
        memory: { koda: { url, headers: { Authorization: bearer, authorization: value } } },
      });

      expect(kodaFlowConnection(config)).toBeUndefined();
    }
  });

  test("returns the connection when the last authorization header is the usable one", () => {
    const headers = { authorization: "", Authorization: bearer };
    const config = makeNaxConfig({ memory: { koda: { url, headers } } });

    expect(kodaFlowConnection(config)).toEqual({ url, headers });
  });
});
