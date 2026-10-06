/**
 * elicitation/create -> question events (S4 spec §6.8 as amended by S4-5 D5-i).
 * Advertised under `ask` and `full` only; under `none` and `read` a request is
 * declined unasked. A form is asked one field at a time through the session's ask
 * port, under the turn binding's signal (D5-j):
 * - no fields: the message alone; a reply accepts with empty content
 * - a string field: the reply, as written
 * - a single-select (`enum` or `oneOf`): a choice named by number, value or title,
 *   trimmed and case-insensitive
 * - a multi-select (`array` with `enum`/`anyOf`/`oneOf` items): comma-separated choices
 * A plain string field `<key>_custom` next to a select `<key>` is its free-text
 * companion (Claude's AskUserQuestion "Other" box): not asked on its own; a reply
 * naming no choice becomes its value. Any other field type, a malformed or oversized
 * choice list, too many fields, or a non-form request declines the form unasked;
 * a reply naming no choice without a companion, or an empty reply to a required
 * field, declines after asking. Each decline is noted with noteQuestion. No reply
 * (deadline, cancel, turn end, process exit) cancels. Question text is agent data:
 * control and invisible characters stripped, secrets scrubbed, capped.
 */
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
} from "@agentclientprotocol/sdk";
import type { AgentSessionProfile, SessionAskPort } from "@nathapp/nax-agent";
import { capBytes, isRecord, scrubSecrets, stripControl, stripInvisible } from "#src/client/text";

export const QUESTION_MAX_BYTES = 4096;
export const MAX_FORM_FIELDS = 16;
export const MAX_CHOICES = 32;
export const NO_MATCH_NOTE = "declined: the reply matches no choice";
export const REQUIRED_NOTE = "declined: an answer is required";
const COMPANION_SUFFIX = "_custom";
/** Agent text longer than this is cut before cleaning; a question is far shorter. */
const QUESTION_SCAN_BYTES = 64 * 1024;

export interface ElicitationContext {
  readonly profile: AgentSessionProfile;
  readonly asks: SessionAskPort;
  readonly secrets: readonly string[];
  /** The turn binding's signal: aborts on cancel, timeout, turn end and process exit. */
  readonly signal: AbortSignal;
}

interface Choice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

interface Field {
  readonly key: string;
  readonly kind: "text" | "single" | "multi";
  readonly title?: string;
  readonly description?: string;
  readonly choices: readonly Choice[];
  readonly required: boolean;
  readonly companion?: string;
}

type Content = Readonly<Record<string, ElicitationContentValue>>;
type Parsed = { readonly ok: true; readonly fields: readonly Field[] } | { readonly ok: false };
type Reply = { readonly ok: true; readonly content: Content } | { readonly ok: false; readonly note: string };

const CANCEL: CreateElicitationResponse = { action: "cancel" };
const DECLINE: CreateElicitationResponse = { action: "decline" };
const REFUSED: Parsed = { ok: false };

function shown(text: string, secrets: readonly string[]): string {
  const visible = stripInvisible(stripControl(capBytes(text, QUESTION_SCAN_BYTES)));
  return capBytes(scrubSecrets(visible, secrets), QUESTION_MAX_BYTES);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function choiceOf(item: unknown): Choice | undefined {
  if (typeof item === "string") return { value: item, label: item };
  if (!isRecord(item) || typeof item.const !== "string") return undefined;
  const description = nonEmpty(item.description);
  return {
    value: item.const,
    label: nonEmpty(item.title) ?? item.const,
    ...(description === undefined ? {} : { description }),
  };
}

/** [] when the schema declares no choices; undefined when its choice list is unusable. */
function choicesOf(schema: Readonly<Record<string, unknown>>): readonly Choice[] | undefined {
  const list = schema.oneOf ?? schema.anyOf ?? schema.enum;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CHOICES) return undefined;
  const choices = list.map(choiceOf);
  return choices.every((choice): choice is Choice => choice !== undefined) ? choices : undefined;
}

function fieldOf(key: string, schema: unknown, required: boolean): Field | undefined {
  if (!isRecord(schema)) return undefined;
  const title = nonEmpty(schema.title);
  const description = nonEmpty(schema.description);
  const base = {
    key,
    required,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
  if (schema.type === "string") {
    const choices = choicesOf(schema);
    if (choices === undefined) return undefined;
    return { ...base, kind: choices.length === 0 ? "text" : "single", choices };
  }
  if (schema.type !== "array" || !isRecord(schema.items)) return undefined;
  const choices = choicesOf(schema.items);
  return choices === undefined || choices.length === 0 ? undefined : { ...base, kind: "multi", choices };
}

/** Folds each `<key>_custom` text field into its select `<key>` (D5-i). */
function withCompanions(fields: readonly Field[]): readonly Field[] {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const folded = new Set<string>();
  const linked = fields.map((field) => {
    const companion = byKey.get(`${field.key}${COMPANION_SUFFIX}`);
    if (field.kind === "text" || companion?.kind !== "text") return field;
    folded.add(companion.key);
    return { ...field, companion: companion.key };
  });
  return linked.filter((field) => !folded.has(field.key));
}

function parseForm(request: unknown): Parsed {
  if (!isRecord(request) || request.mode !== "form" || !isRecord(request.requestedSchema)) return REFUSED;
  const schema = request.requestedSchema;
  const properties = schema.properties ?? {};
  if (!isRecord(properties)) return REFUSED;
  const entries = Object.entries(properties);
  if (entries.length > MAX_FORM_FIELDS) return REFUSED;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = entries.map(([key, property]) => fieldOf(key, property, required.has(key)));
  return fields.every((field): field is Field => field !== undefined)
    ? { ok: true, fields: withCompanions(fields) }
    : REFUSED;
}

function instruction(field: Field): string {
  const own = field.companion === undefined ? "" : ", or type your own answer";
  const skip = field.required ? "" : " Leave empty to skip.";
  if (field.kind === "single") return `Reply with one number or choice${own}.${skip}`;
  if (field.kind === "multi") return `Reply with numbers or choices, separated by commas${own}.${skip}`;
  return field.required ? "Reply with your answer." : "Reply with your answer, or leave it empty to skip.";
}

function questionText(message: string, field: Field, index: number, count: number): string {
  const head = count > 1 ? `(${index + 1}/${count}) ` : "";
  const label = [field.title, field.description].filter((part) => part !== undefined).join(": ");
  const heading = `${head}${label}`.trim();
  return [
    ...(index === 0 && message.trim() !== "" ? [message.trim()] : []),
    ...(heading === "" ? [] : [heading]),
    ...field.choices.map(
      (choice, i) => `${i + 1}. ${choice.label}${choice.description ? ` - ${choice.description}` : ""}`,
    ),
    instruction(field),
  ].join("\n");
}

function matchChoice(choices: readonly Choice[], text: string): Choice | undefined {
  const byNumber = /^\d+$/.test(text) ? choices[Number(text) - 1] : undefined;
  const wanted = text.toLowerCase();
  return byNumber ?? choices.find((c) => c.value.toLowerCase() === wanted || c.label.toLowerCase() === wanted);
}

const accepted = (content: Content): Reply => ({ ok: true, content });
const NO_MATCH: Reply = { ok: false, note: NO_MATCH_NOTE };

function singleReply(field: Field, reply: string): Reply {
  const choice = matchChoice(field.choices, reply);
  if (choice !== undefined) return accepted({ [field.key]: choice.value });
  return field.companion === undefined || field.required ? NO_MATCH : accepted({ [field.companion]: reply });
}

function multiReply(field: Field, reply: string): Reply {
  const parts = reply
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const matched = parts.map((part) => matchChoice(field.choices, part));
  const values = [...new Set(matched.flatMap((choice) => (choice === undefined ? [] : [choice.value])))];
  const others = parts.filter((_, i) => matched[i] === undefined);
  if (others.length > 0 && field.companion === undefined) return NO_MATCH;
  if (values.length === 0 && field.required) return NO_MATCH;
  return accepted({
    ...(values.length === 0 ? {} : { [field.key]: values }),
    ...(others.length === 0 || field.companion === undefined ? {} : { [field.companion]: others.join(", ") }),
  });
}

function applyReply(field: Field, reply: string): Reply {
  if (reply === "") return field.required ? { ok: false, note: REQUIRED_NOTE } : accepted({});
  if (field.kind === "single") return singleReply(field, reply);
  if (field.kind === "multi") return multiReply(field, reply);
  return accepted({ [field.key]: reply });
}

async function ask(text: string, ctx: ElicitationContext): Promise<string | null> {
  if (ctx.signal.aborted) return null;
  return ctx.asks.askQuestion(shown(text, ctx.secrets), { signal: ctx.signal }).catch(() => null);
}

async function askFields(
  message: string,
  fields: readonly Field[],
  ctx: ElicitationContext,
): Promise<CreateElicitationResponse> {
  if (fields.length === 0) return (await ask(message, ctx)) === null ? CANCEL : { action: "accept", content: {} };
  let content: Content = {};
  for (const [index, field] of fields.entries()) {
    const reply = await ask(questionText(message, field, index, fields.length), ctx);
    if (reply === null) return CANCEL;
    const outcome = applyReply(field, reply.trim());
    if (!outcome.ok) {
      ctx.asks.noteQuestion(outcome.note);
      return DECLINE;
    }
    content = { ...content, ...outcome.content };
  }
  return { action: "accept", content };
}

export async function answerElicitation(
  request: CreateElicitationRequest,
  ctx: ElicitationContext,
): Promise<CreateElicitationResponse> {
  if (ctx.profile !== "ask" && ctx.profile !== "full") return DECLINE;
  const message = typeof request.message === "string" ? request.message : "";
  const parsed = parseForm(request);
  if (!parsed.ok) {
    ctx.asks.noteQuestion(shown(`declined: ${message}`, ctx.secrets));
    return DECLINE;
  }
  return askFields(message, parsed.fields, ctx);
}
