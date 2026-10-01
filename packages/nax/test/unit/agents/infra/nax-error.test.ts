import { describe, expect, test } from "bun:test";
import * as infra from "@/agents/infra";
import { LockAcquisitionError, NaxError } from "@/errors";

const InfraNaxError = infra.NaxError;

describe("NaxError in the move set", () => {
  test("@/errors re-exports the same class object", () => {
    expect(InfraNaxError).toBe(NaxError);
  });

  test("an error thrown from the move set matches nax's instanceof checks", () => {
    const err = new InfraNaxError("boom", "SOME_CODE", { stage: "x" });
    expect(err).toBeInstanceOf(NaxError);
    expect(err.name).toBe("NaxError");
    expect(err.code).toBe("SOME_CODE");
    expect(err.context).toEqual({ stage: "x" });
  });

  test("nax's subclasses still extend the moved class", () => {
    const err = new LockAcquisitionError({ workdir: "/w" });
    expect(err).toBeInstanceOf(InfraNaxError);
    expect(err.code).toBe("LOCK_ACQUISITION_FAILED");
  });
});
