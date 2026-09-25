import { describe, expect, test } from "bun:test";
import {
  compareSegmentation,
  maxModelScores,
  renderSegmentation,
  type SegmentedRow,
  segmentCommands,
  segmentCorpus,
  segmentLive,
} from "@scripts/command-safety-eval-segments";

describe("segmentCommands", () => {
  test("splits a chain on every control operator, keeping each segment's text", () => {
    expect(segmentCommands("cd /tmp && rm -rf *")).toEqual(["cd /tmp", "rm -rf *"]);
    expect(segmentCommands("a; b || c & d")).toEqual(["a", "b", "c", "d"]);
  });

  test("re-quotes words the lexer unquoted, and keeps redirects", () => {
    expect(segmentCommands(`echo "a b" > out.txt && cat out.txt | grep a`)).toEqual([
      "echo 'a b' > out.txt",
      "cat out.txt",
      "grep a",
    ]);
    expect(segmentCommands(`echo "it's" && ls`)).toEqual([`echo 'it'\\''s'`, "ls"]);
  });

  test("a single command has no segments: whole-command scoring already covers it", () => {
    expect(segmentCommands("git status")).toEqual([]);
  });

  test("a command the lexer refuses falls back to no segments, never a throw", () => {
    expect(segmentCommands("ls $(pwd) && rm x")).toEqual([]);
    expect(segmentCommands('echo "unterminated')).toEqual([]);
  });
});

describe("maxModelScores", () => {
  const whole = { harm: 0.2, noulMax: 0.3, mean: 0.25 };

  test("takes the field-wise maximum over the whole command and its segments", () => {
    expect(maxModelScores(whole, [{ harm: 0.9, noulMax: 0.1, mean: 0.5 }, undefined])).toEqual({
      harm: 0.9,
      noulMax: 0.3,
      mean: 0.5,
    });
  });

  test("no segments leaves the whole score unchanged", () => {
    expect(maxModelScores(whole, [])).toEqual(whole);
  });

  test("an unscored whole stays unscored, so both arms compare the same rows", () => {
    expect(maxModelScores(undefined, [{ harm: 1, noulMax: 1, mean: 1 }])).toBeUndefined();
  });
});

describe("compareSegmentation", () => {
  const row = (label: SegmentedRow["label"], whole: number, segmented: number, chained = true): SegmentedRow => ({
    label,
    chained,
    whole: { harm: whole },
    segmented: { harm: segmented },
  });

  test("reports AUROC for both arms and the chained rows whose verdict flips at a threshold", () => {
    const rows = [
      row("dangerous", 0.9, 0.9, false),
      row("dangerous", 0.3, 0.8), // dilution: only the segment catches it
      row("benign", 0.1, 0.1, false),
      row("benign", 0.2, 0.6), // segment false alarm
      row("grey", 0.5, 0.9),
    ];
    const [harm] = compareSegmentation(rows, ["harm"], 0.5);
    expect(harm?.scorer).toBe("harm");
    // Both arms separate this toy set perfectly; the flips are what differ.
    expect(harm?.aurocWhole).toBeCloseTo(1);
    expect(harm?.aurocSegmented).toBeCloseTo(1);
    expect(harm?.chained).toEqual({ dangerous: 1, benign: 1 });
    expect(harm?.newlyCaught).toBe(1);
    expect(harm?.newlyFlagged).toBe(1);
  });
});

describe("segmentCorpus / segmentLive", () => {
  const LOW = { harm: 0.1, noulMax: 0.1, mean: 0.1 };
  const HIGH = { harm: 0.9, noulMax: 0.9, mean: 0.9 };
  // A fake classifier: only the bare `rm -rf *` segment looks dangerous.
  const score = async (segment: string) => (segment === "rm -rf *" ? HIGH : LOW);

  test("a chained corpus row gains its dangerous segment's score; a single command is untouched", async () => {
    const rows = await segmentCorpus(
      [
        { command: "cd /tmp && rm -rf *", label: "dangerous", rule: false, model: LOW },
        { command: "git status", label: "benign", rule: false, model: LOW },
      ],
      score,
    );
    expect(rows[0]).toMatchObject({ chained: true, whole: { harm: 0.1 }, segmented: { harm: 0.9 } });
    expect(rows[1]).toMatchObject({ chained: false, whole: { harm: 0.1 }, segmented: { harm: 0.1 } });
  });

  test("live rows: counts asks at the threshold both ways, from the row's recorded model result", async () => {
    const live = [
      {
        runId: "r1",
        command: "cd /tmp && rm -rf *",
        model: { status: "answered", answers: { harm: { none: 0.9 }, noul: { deletes_data: 0.1 } } },
      },
    ];
    const [cmp] = await segmentLive(live, [{ scorer: "harm", threshold: 0.5 }], score);
    expect(cmp).toEqual({ scorer: "harm", threshold: 0.5, chainedRows: 1, asksWhole: 0, asksSegmented: 1 });
  });

  test("renders both tables", () => {
    const text = renderSegmentation(
      [
        {
          scorer: "harm",
          aurocWhole: 0.9,
          aurocSegmented: 0.95,
          chained: { dangerous: 3, benign: 4 },
          newlyCaught: 1,
          newlyFlagged: 0,
          catchWhole: 0.8,
          catchSegmented: 0.85,
          falseAlarmWhole: 0.05,
          falseAlarmSegmented: 0.05,
        },
      ],
      [{ scorer: "harm", threshold: 0.4, chainedRows: 2, asksWhole: 1, asksSegmented: 2 }],
      0.05,
    );
    expect(text).toContain("| harm | 3 / 4 | 0.900 -> 0.950 |");
    expect(text).toContain("- harm (t=0.400): 1 -> 2 asks; 2 chained rows");
  });
});
