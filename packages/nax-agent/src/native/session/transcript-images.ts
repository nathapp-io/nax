import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage, ImageAttachment } from "@nathapp/nax-ai";
import { NaxError } from "#src/infra/index";
import { writeFileAtomic } from "#src/internal/atomic-write";
import type { TranscriptDoc } from "./transcript-types.ts";

/** Filesystem operations separate from the atomic writer's write/rename seam. */
export const _transcriptImagesDeps = {
  link,
  mkdir,
  readFile: (path: string) => readFile(path),
  rm,
  stat: (path: string) => stat(path),
  writeFileAtomic,
};

const extensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

type UserMessage = Extract<ConversationMessage, { role: "user" }>;
type StoredImage = Omit<ImageAttachment, "data"> & { readonly ref: string };
type StoredMessage =
  | Exclude<ConversationMessage, UserMessage>
  | (Omit<UserMessage, "images"> & { readonly images?: readonly StoredImage[] });
type StoredDoc = Omit<TranscriptDoc, "schemaVersion" | "messages"> & {
  readonly schemaVersion?: 1 | 2;
  readonly messages: readonly StoredMessage[];
};

export function transcriptImagesPath(path: string): string {
  return path.replace(/\.json$/, ".images");
}

function extension(mimeType: string): string {
  const ext = Object.hasOwn(extensions, mimeType) ? extensions[mimeType] : undefined;
  if (ext !== undefined) return ext;
  throw new NaxError(`Unsupported transcript image type: ${mimeType}`, "TRANSCRIPT_IMAGE_TYPE_UNSUPPORTED", {
    stage: "native-session",
  });
}

/** A hard link publishes complete bytes atomically, failing rather than replacing a winner. */
async function publishImageOnce(path: string, bytes: Uint8Array): Promise<void> {
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    // Keep atomic staging (and its rename seam), but never rename over the final name.
    await _transcriptImagesDeps.writeFileAtomic(staged, bytes);
    try {
      await _transcriptImagesDeps.link(staged, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another writer published this content-addressed image first; leave it untouched.
    }
  } finally {
    await _transcriptImagesDeps.rm(staged, { force: true });
  }
}

async function publishImage(folder: string, image: ImageAttachment): Promise<StoredImage> {
  const bytes = Buffer.from(image.data, "base64");
  const ref = createHash("sha256").update(bytes).digest("hex");
  const path = join(folder, `${ref}.${extension(image.mimeType)}`);
  try {
    await _transcriptImagesDeps.stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await publishImageOnce(path, bytes);
  }
  const { data: _data, ...metadata } = image;
  return { ...metadata, ref };
}

/** Preflight the WHOLE document before even creating the image directory. */
export async function splitTranscriptImages(path: string, doc: TranscriptDoc): Promise<unknown> {
  let hasImages = false;
  for (const message of doc.messages) {
    if (message.role !== "user") continue;
    for (const image of message.images ?? []) {
      extension(image.mimeType);
      hasImages = true;
    }
  }
  if (!hasImages) return doc;
  const folder = transcriptImagesPath(path);
  await _transcriptImagesDeps.mkdir(folder, { recursive: true });
  const messages: StoredMessage[] = [];
  // Sequential publication deduplicates repeated images within this save too.
  for (const message of doc.messages) {
    if (message.role !== "user" || !message.images?.length) {
      messages.push(message as StoredMessage);
      continue;
    }
    const images: StoredImage[] = [];
    for (const image of message.images) images.push(await publishImage(folder, image));
    messages.push({ ...message, images });
  }
  return { ...doc, schemaVersion: 2, messages } satisfies StoredDoc;
}

async function readStoredImage(folder: string, image: StoredImage): Promise<ImageAttachment | null> {
  const { ref, ...metadata } = image;
  // Validate both fields before deriving a path or touching the filesystem.
  if (typeof ref !== "string" || !/^[a-f0-9]{64}$/.test(ref) || !Object.hasOwn(extensions, image.mimeType)) {
    return null;
  }
  try {
    const bytes = await _transcriptImagesDeps.readFile(join(folder, `${ref}.${extensions[image.mimeType]}`));
    return { ...metadata, data: bytes.toString("base64") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Decode the private disk format; callers only ever see inline attachments. */
export async function rehydrateTranscriptImages(path: string, value: object): Promise<TranscriptDoc> {
  const doc = value as StoredDoc;
  if (typeof doc.schemaVersion === "number" && doc.schemaVersion > 2) {
    throw new NaxError(`Unsupported transcript schemaVersion ${doc.schemaVersion}`, "TRANSCRIPT_SCHEMA_UNSUPPORTED", {
      stage: "native-session",
    });
  }
  if (doc.schemaVersion !== 2) return value as TranscriptDoc;
  const { schemaVersion: _version, ...rest } = doc;
  const messages: ConversationMessage[] = [];
  for (const message of doc.messages) {
    if (message.role !== "user" || !message.images?.length) {
      messages.push(message as ConversationMessage);
      continue;
    }
    const images: ImageAttachment[] = [];
    let content = message.content;
    for (const image of message.images) {
      const hydrated = await readStoredImage(transcriptImagesPath(path), image);
      if (hydrated) images.push(hydrated);
      else content = content ? `${content}\n[image missing]` : "[image missing]";
    }
    const { images: _storedImages, ...text } = message;
    messages.push({ ...text, content, ...(images.length ? { images } : {}) });
  }
  return { ...rest, messages };
}
