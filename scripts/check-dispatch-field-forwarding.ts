#!/usr/bin/env bun
/**
 * Guard: dispatch event builders must forward every correlation id.
 *
 * Four separate passes of the same defect class shipped — a correlation id
 * (`callId`, `scopeId`, `turnId`) produced upstream and silently dropped by a
 * dispatch event builder between the producer and the sink. A canary guard was
 * expected to make a fourth impossible; it does not exist in this tree, so this
 * file is that guard.
 *
 * The check is deliberately source-text: it reads
 * `src/agents/manager-dispatch.ts`, isolates each builder's returned object
 * literal, and requires the literal identifiers to appear in the construction.
 * That is the shape the other `scripts/check-*` gates take, it runs in CI, and
 * it fires on every historical pass of this defect.
 *
 * - `buildSessionTurnEvent` must forward `turnId` inside `protocolIds`, plus
 *   `callId` and `scopeId` on the event.
 * - `buildDispatchErrorEvent` must forward the flat `turnId`.
 *
 * Usage: bun run scripts/check-dispatch-field-forwarding.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const TARGET = join(import.meta.dir, "..", "src", "agents", "manager-dispatch.ts");

interface FieldRequirement {
  /** Function that owns the event construction. */
  fn: string;
  /** Identifier that must survive into the event. */
  id: string;
  /** Nested object of the return literal the id must appear in (e.g. protocolIds). */
  nested?: string;
}

const REQUIREMENTS: FieldRequirement[] = [
  { fn: "buildSessionTurnEvent", id: "turnId", nested: "protocolIds" },
  { fn: "buildSessionTurnEvent", id: "callId" },
  { fn: "buildSessionTurnEvent", id: "scopeId" },
  { fn: "buildDispatchErrorEvent", id: "turnId" },
];

/** Blank comments and string/template literals, preserving offsets and newlines. */
function blankNonCode(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote) break;
        j++;
      }
      blank(i, Math.min(j + 1, text.length));
      i = Math.min(j + 1, text.length);
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Index of the delimiter matching the one at `openIdx`, or -1 when unbalanced. */
function matchDelimiter(code: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === open) depth++;
    else if (code[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Returned object literal of `fn`'s body, or null when the shape is unrecognizable. */
function returnObjectOf(code: string, fn: string): string | null {
  const signature = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\s*\\(`).exec(code);
  if (signature === null) return null;
  const openParen = signature.index + signature[0].length - 1;
  const closeParen = matchDelimiter(code, openParen, "(", ")");
  if (closeParen === -1) return null;
  const openBody = code.indexOf("{", closeParen);
  if (openBody === -1) return null;
  const closeBody = matchDelimiter(code, openBody, "{", "}");
  if (closeBody === -1) return null;

  const body = code.slice(openBody, closeBody + 1);
  const ret = body.indexOf("return {");
  if (ret === -1) return null;
  const openLiteral = body.indexOf("{", ret);
  const closeLiteral = matchDelimiter(body, openLiteral, "{", "}");
  if (closeLiteral === -1) return null;
  return body.slice(openLiteral, closeLiteral + 1);
}

/** Named nested object inside a return literal, or null when absent. */
function nestedObjectOf(literal: string, field: string): string | null {
  const m = new RegExp(`\\b${field}\\s*:\\s*\\{`).exec(literal);
  if (m === null) return null;
  const openBrace = literal.indexOf("{", m.index + m[0].length - 1);
  const closeBrace = matchDelimiter(literal, openBrace, "{", "}");
  if (closeBrace === -1) return null;
  return literal.slice(openBrace, closeBrace + 1);
}

/** Null when the requirement holds, else a human-readable failure. */
function evaluate(code: string, req: FieldRequirement): string | null {
  const literal = returnObjectOf(code, req.fn);
  if (literal === null) return `${req.fn}: no returned object literal found`;
  const scope = req.nested === undefined ? literal : nestedObjectOf(literal, req.nested);
  if (scope === null) return `${req.fn}: ${req.nested} object not found in the event`;
  if (new RegExp(`\\b${req.id}\\b`).test(scope)) return null;
  const where = req.nested === undefined ? "the event" : req.nested;
  return `${req.fn}: dropped ${req.id} (not forwarded on ${where})`;
}

function main(): void {
  const code = blankNonCode(readFileSync(TARGET, "utf8"));
  const missing = REQUIREMENTS.map((req) => evaluate(code, req)).filter((m): m is string => m !== null);

  if (missing.length > 0) {
    console.error("ERROR: dispatch event builder(s) dropped a correlation id:");
    for (const m of missing) console.error(`  - ${m}`);
    console.error("");
    console.error("A correlation id produced upstream and dropped here cannot be joined at the sink.");
    console.error("Forward `turnId` inside protocolIds on buildSessionTurnEvent, `callId`/`scopeId`");
    console.error("onto the event, and the flat `turnId` on buildDispatchErrorEvent.");
    process.exit(1);
  }

  console.log(`OK: dispatch field forwarding guard passed (${REQUIREMENTS.length} correlation fields).`);
}

if (import.meta.main) main();
