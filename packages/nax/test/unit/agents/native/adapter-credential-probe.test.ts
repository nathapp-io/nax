/**
 * The native adapter's install and credential probes: always installed (in
 * process), credentialed when a credential is stored or ambient, and fail-open
 * when the store cannot be read.
 *
 * Split out of adapter.test.ts (S1-5) by concern; the cases are unchanged.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { _adapterDeps } from "@nathapp/nax-agent/internal";
import { NativeAgentAdapter } from "@/agents/native-agent";

const REAL_LIST = _adapterDeps.listStoredProviders;
const REAL_SWEEP = _adapterDeps.anyAmbientCredential;

afterEach(() => {
  _adapterDeps.listStoredProviders = REAL_LIST;
  _adapterDeps.anyAmbientCredential = REAL_SWEEP;
});

describe("isInstalled", () => {
  test("is true even when hasCredentials is false: in-process, nothing to install", async () => {
    const adapter = new NativeAgentAdapter();
    // Force the credential probe to say no. If isInstalled still delegates,
    // it returns false and this fails.
    adapter.hasCredentials = async () => false;

    expect(await adapter.isInstalled()).toBe(true);
  });
});

describe("hasCredentials", () => {
  test("is true when a credential is stored, without sweeping ambient auth", async () => {
    let swept = false;
    _adapterDeps.listStoredProviders = async () => [{ providerId: "minimax", kind: "api-key" as const }];
    _adapterDeps.anyAmbientCredential = async () => {
      swept = true;
      return false;
    };

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
    expect(swept).toBe(false);
  });

  test("falls back to the ambient sweep when nothing is stored", async () => {
    _adapterDeps.listStoredProviders = async () => [];
    _adapterDeps.anyAmbientCredential = async () => true;

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
  });

  test("is false only when nothing is stored and nothing is ambient", async () => {
    _adapterDeps.listStoredProviders = async () => [];
    _adapterDeps.anyAmbientCredential = async () => false;

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(false);
  });

  test("an unreadable credential file does not prune the agent", async () => {
    _adapterDeps.listStoredProviders = async () => {
      throw new Error("EACCES");
    };
    _adapterDeps.anyAmbientCredential = async () => false;

    // Fail open: an unreadable store is "unknown", not "no credentials".
    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
  });
});
