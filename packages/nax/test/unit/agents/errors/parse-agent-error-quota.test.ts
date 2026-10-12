import { describe, expect, test } from "bun:test";
import { classifyCompleteException } from "@/agents/complete-exception-classifier";
import { classifyParsedAgentError, isQuotaMessage, parseAgentError } from "@/agents/errors/parse-agent-error";

const MINIMAX_2056 =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)"},"request_id":"071bcc0b16aa41f1df8e44bb58fc234e"}';
const SLOW_DOWN =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded, please slow down"}}';

describe("quota classification", () => {
  test("isQuotaMessage matches usage-limit / quota / credits wording, not plain rate limits", () => {
    expect(isQuotaMessage("Token Plan usage limit reached")).toBe(true);
    expect(isQuotaMessage("You exceeded your current quota, please check your plan")).toBe(true);
    expect(isQuotaMessage("insufficient credits")).toBe(true);
    expect(isQuotaMessage("Rate limit exceeded, please slow down")).toBe(false);
  });

  test("a per-minute 'Quota exceeded' 429 is not quota", () => {
    const perMinute = "Quota exceeded for quota metric 'Generate Content API requests per minute'";
    expect(isQuotaMessage(perMinute)).toBe(false);
    const raw = `429 {"type":"error","error":{"type":"rate_limit_error","message":"${perMinute}"}}`;
    const parsed = parseAgentError(raw);
    expect(parsed?.type).toBe("rate-limit");
    expect(classifyParsedAgentError(parsed, raw)?.adapterFailure?.outcome).toBe("fail-rate-limit");
  });

  test("the MiniMax 2056 token-plan 429 parses as quota and maps to fail-quota", () => {
    const parsed = parseAgentError(MINIMAX_2056);
    expect(parsed?.type).toBe("quota");
    const result = classifyParsedAgentError(parsed, MINIMAX_2056);
    expect(result?.adapterFailure?.outcome).toBe("fail-quota");
    expect(result?.adapterFailure?.retriable).toBe(false);
  });

  test("a plain rate-limit 429 stays fail-rate-limit (Review Focus 2)", () => {
    const parsed = parseAgentError(SLOW_DOWN);
    expect(parsed?.type).toBe("rate-limit");
    expect(classifyParsedAgentError(parsed, SLOW_DOWN)?.adapterFailure?.outcome).toBe("fail-rate-limit");
  });

  test("a quota-shaped code token with quota wording is quota; a bare 429 stays rate-limit", () => {
    expect(parseAgentError('{"code":"RESOURCE_EXHAUSTED","message":"You exceeded your current quota"}').type).toBe(
      "quota",
    );
    expect(parseAgentError('{"code":"QUOTA_EXCEEDED","message":"slow down"}').type).toBe("rate-limit");
    expect(parseAgentError("statusCode=429 insufficient credits").type).toBe("quota");
    expect(parseAgentError("statusCode=429").type).toBe("rate-limit");
  });

  test("classifyCompleteException maps the MiniMax fixture to a non-retriable fail-quota", () => {
    const failure = classifyCompleteException(new Error(MINIMAX_2056));
    expect(failure.outcome).toBe("fail-quota");
    expect(failure.retriable).toBe(false);
  });
});
