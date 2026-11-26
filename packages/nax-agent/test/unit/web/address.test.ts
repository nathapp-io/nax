import { afterEach, describe, expect, test } from "bun:test";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { NaxError } from "#src/infra/index";
import { _webAddressDeps, createCheckedLookup, isBlockedAddress } from "#src/web/address";

const realLookup = _webAddressDeps.lookup;

afterEach(() => {
  _webAddressDeps.lookup = realLookup;
});

/** A resolver that answers every lookup with one address, the way a non-`all` lookup does. */
function stubSingleAddress(address: string, family = 4): void {
  _webAddressDeps.lookup = (_hostname, _options, callback) => {
    callback(null, address, family);
  };
}

/** A resolver that answers every lookup with a list, the way an `all: true` lookup does. */
function stubAllAddresses(addresses: readonly LookupAddress[]): void {
  _webAddressDeps.lookup = (_hostname, _options, callback) => {
    callback(null, [...addresses]);
  };
}

interface LookupOutcome {
  readonly error: NodeJS.ErrnoException | null;
  readonly address: string | LookupAddress[] | undefined;
  readonly family: number | undefined;
}

/** Run one lookup and collect what it called back with. */
function runLookup(lookup: LookupFunction, options: LookupOptions = {}): Promise<LookupOutcome> {
  return new Promise((resolve) => {
    lookup("a.example", options, (error, address, family) => {
      resolve({ error, address, family });
    });
  });
}

const BLOCKED_ADDRESSES: string[] = [
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "::",
  "169.254.169.254",
  "::ffff:169.254.169.254",
  "10.1.2.3",
  "172.16.0.1",
  "192.168.1.10",
  "100.64.0.1",
  "fd00::1",
  "fe80::1",
  "224.0.0.1",
  "240.0.0.1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
];

const PUBLIC_ADDRESSES: string[] = ["93.184.216.34", "2606:2800:220:1::1", "172.32.0.1"];

describe("isBlockedAddress", () => {
  test.each(BLOCKED_ADDRESSES)("isBlockedAddress(%s) is true", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  test.each(PUBLIC_ADDRESSES)("isBlockedAddress(%s) is false", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  test("a value that is not an address is refused rather than trusted", () => {
    expect(isBlockedAddress("not-an-address")).toBe(true);
  });
});

describe("createCheckedLookup", () => {
  const lookup = createCheckedLookup({ allowOrigins: [], origin: "https://a.example" });

  test("calls back with a public address unchanged", async () => {
    stubSingleAddress("93.184.216.34");
    const outcome = await runLookup(lookup);
    expect(outcome.error).toBeNull();
    expect(outcome.address).toBe("93.184.216.34");
  });

  test("calls back with WEB_ADDRESS_BLOCKED when the answer is a private address", async () => {
    stubSingleAddress("10.0.0.5");
    const outcome = await runLookup(lookup);
    expect(outcome.error?.code).toBe("WEB_ADDRESS_BLOCKED");
  });

  test("the blocked error names the host that resolved to the private address", async () => {
    stubSingleAddress("10.0.0.5");
    const outcome = await runLookup(lookup);
    expect(outcome.error?.message).toBe("refused to fetch a.example: it resolves to a private or local address");
    expect(outcome.error).toBeInstanceOf(NaxError);
  });

  test("refuses an all: true answer where any address is blocked", async () => {
    stubAllAddresses([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const outcome = await runLookup(lookup, { all: true });
    expect(outcome.error?.code).toBe("WEB_ADDRESS_BLOCKED");
  });

  test("passes an all: true answer through unchanged when every address is public", async () => {
    const answers: LookupAddress[] = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ];
    stubAllAddresses(answers);
    const outcome = await runLookup(lookup, { all: true });
    expect(outcome.error).toBeNull();
    expect(outcome.address).toEqual(answers);
  });

  test("passes a resolver error through rather than reporting it as a blocked address", async () => {
    _webAddressDeps.lookup = (_hostname, _options, callback) => {
      const failure: NodeJS.ErrnoException = new Error("getaddrinfo ENOTFOUND a.example");
      failure.code = "ENOTFOUND";
      callback(failure, "", 0);
    };
    const outcome = await runLookup(lookup);
    expect(outcome.error?.code).toBe("ENOTFOUND");
  });

  test("an allowed origin skips the address check", async () => {
    const searxng = "http://search.example.lan:8080";
    const exemptLookup = createCheckedLookup({ allowOrigins: [searxng], origin: searxng });
    stubSingleAddress("192.168.1.20");
    const outcome = await runLookup(exemptLookup);
    expect(outcome.error).toBeNull();
    expect(outcome.address).toBe("192.168.1.20");
  });
});
