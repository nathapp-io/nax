/**
 * Preparing an image send: the one place that decides what a plain chat message actually
 * carries to the brain, and the only place that asks whether the brain can read images.
 *
 * Three things meet here that cannot meet anywhere else. The draft's placeholders become a
 * numbered image list (`imagesForSend`), and the text the user typed becomes the text the
 * brain reads. The mentions in that text become records, and a mentioned image becomes an
 * attachment — but only when the brain reads images, because a text-only brain must keep
 * today's path-only record rather than refuse the whole send. And the combined list is the
 * one that has to satisfy the shared limits, so a message that is fine draft-by-draft can
 * still be refused whole.
 *
 * The capability is asked at most once per send, and never when nothing depends on it: a
 * message with no placeholder image and no mention is the plain send it always was. A
 * capability that rejects is a capability that said no — the send is refused rather than
 * thrown, because the screen's answer to a failed probe must be a notice, not an error row.
 *
 * Everything here is pure but for the injected `expand` and `acceptsImages`; the caller owns
 * restoring a refused draft and sending a composed one.
 */
import { type ImageAttachment, validateImageAttachments } from "@nathapp/nax-agent";
import type { MentionWhere } from "@/chat";
import { type ImageDraft, imagesForSend } from "./image-draft";
import { type MentionExpander, needsMentionExpansion } from "./mention-send";

/** What one submitted message gives the prepare step: its text, its draft, and its seams. */
export interface ImageSendInput {
  /** The submitted text, exactly as the prompt held it. */
  readonly text: string;
  /** The images attached to the prompt when the send was submitted. */
  readonly draft: ImageDraft;
  /** Where a mention is resolved, and whether the brain there reads images. */
  readonly where: MentionWhere;
  /** The screen's mention expander (`_chatAppDeps.expandMentions`). */
  readonly expand: MentionExpander;
  /** Whether the open session reads images; a rejection counts as `false`. */
  readonly acceptsImages: () => Promise<boolean>;
  /** The model the notice names back, e.g. `openai/text-only`. */
  readonly model: string;
}

/** Either the message and images to send, or the notice to show instead. */
export type ImageSendResult =
  | { readonly kind: "send"; readonly message: string; readonly images: readonly ImageAttachment[] }
  | { readonly kind: "refuse"; readonly notice: string };

/** What a refusal opens with when the validator is the one saying no. */
const NOT_SENT_PREFIX = "images not sent: ";

/** Whether the brain behind `acceptsImages` reads images, with a rejection read as `false`. */
async function readsImages(acceptsImages: () => Promise<boolean>): Promise<boolean> {
  try {
    return await acceptsImages();
  } catch {
    // Fail safe: an unanswerable capability is treated as "cannot read images", so a send
    // that might not be readable is refused rather than attempted.
    return false;
  }
}

/** The text a send carries, and the images that travel with it, in the order they arrived. */
interface ComposedSend {
  readonly message: string;
  readonly images: readonly ImageAttachment[];
}

/** One send, mid-composition: the input it came from and what the draft already resolved. */
interface ComposeRequest {
  readonly input: ImageSendInput;
  /** The submitted text with its placeholders renumbered `1..k`. */
  readonly renumbered: string;
  /** The draft images whose placeholder survived, in placeholder order. */
  readonly placeholder: readonly ImageAttachment[];
  /**
   * The capability answer when the gate already needed one, and `undefined` when nothing has
   * asked yet — which only a message with no placeholder image can be, and which a mention
   * then asks once.
   */
  readonly reads: boolean | undefined;
}

/**
 * The message and images of a send whose capability is settled: the renumbered text when
 * there is nothing to expand, and otherwise what the expander makes of it.
 *
 * A brain that does not read images is handed `where` exactly as it came in, so its expander
 * call is the one it always made; a brain that does gets the mentioned images attached. Those
 * attachments are appended after the placeholder images, so the leading run is what the user
 * pasted and the trailing run is what they mentioned.
 */
async function composeSend(request: ComposeRequest): Promise<ComposedSend> {
  const { input, renumbered, placeholder, reads } = request;
  if (!needsMentionExpansion(renumbered)) return { message: renumbered, images: placeholder };
  const canReadImages = reads ?? (await readsImages(input.acceptsImages));
  const where: MentionWhere = canReadImages ? { ...input.where, images: true } : input.where;
  const expanded = await input.expand(renumbered, where);
  return { message: expanded.message, images: [...placeholder, ...(expanded.images ?? [])] };
}

/**
 * Everything one submitted message carries out: the text with its placeholders renumbered,
 * the draft's images followed by the mentioned ones, or the notice that says why it goes
 * nowhere. The capability gate runs before the expansion, so a refused send costs no reads.
 */
export async function prepareImageSend(input: ImageSendInput): Promise<ImageSendResult> {
  const { text: renumbered, images: placeholder } = imagesForSend(input.draft, input.text);
  const reads = placeholder.length === 0 ? undefined : await readsImages(input.acceptsImages);
  if (reads === false) {
    return { kind: "refuse", notice: `${input.model} cannot read images; switch model (/model) or remove the image` };
  }
  const composed = await composeSend({ input, renumbered, placeholder, reads });
  const reason = validateImageAttachments(composed.images);
  if (reason !== undefined) return { kind: "refuse", notice: `${NOT_SENT_PREFIX}${reason}` };
  return { kind: "send", message: composed.message, images: composed.images };
}
