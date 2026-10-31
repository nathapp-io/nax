import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ConversationMessage, ImageAttachment } from "@nathapp/nax-ai";
import { NaxError } from "#src/infra/index";
import { writeFileAtomic } from "#src/internal/atomic-write";
import type { TranscriptDoc } from "./transcript-types.ts";

/** Filesystem operations separate from the atomic writer's write/rename seam. */
export const _transcriptImagesDeps = {
  link,
  mkdir,
  open,
  realpath,
  lstat,
  readFile: (path: string | FileHandle) => readFile(path),
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

async function assertSafeImageFolder(folder: string): Promise<void> {
  if ((await canonicalImageFolder(folder)) === null) {
    throw new NaxError("Unsafe transcript image sidecar", "TRANSCRIPT_IMAGE_PATH_UNSAFE", {
      stage: "native-session",
    });
  }
}

async function publishImage(folder: string, image: ImageAttachment): Promise<StoredImage> {
  await assertSafeImageFolder(folder);
  const bytes = Buffer.from(image.data, "base64");
  const ref = createHash("sha256").update(bytes).digest("hex");
  const path = join(folder, `${ref}.${extension(image.mimeType)}`);
  try {
    await _transcriptImagesDeps.stat(path);
    const entry = await _transcriptImagesDeps.lstat(path);
    if (!entry.isFile()) {
      throw new NaxError("Unsafe transcript image entry", "TRANSCRIPT_IMAGE_PATH_UNSAFE", {
        stage: "native-session",
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await publishImageOnce(path, bytes);
  }
  if ((await readImageBytes(folder, basename(path))) === null) {
    throw new NaxError("Unsafe transcript image entry", "TRANSCRIPT_IMAGE_PATH_UNSAFE", {
      stage: "native-session",
    });
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
  await assertSafeImageFolder(folder);
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

/** Reject redirected sidecars as well as symlinked image entries. */
async function canonicalImageFolder(folder: string): Promise<string | null> {
  if (!(await _transcriptImagesDeps.lstat(folder)).isDirectory()) return null;
  const parent = await _transcriptImagesDeps.realpath(dirname(folder));
  const expected = join(parent, basename(folder));
  return (await _transcriptImagesDeps.realpath(folder)) === expected ? expected : null;
}

async function readImageBytes(folder: string, name: string): Promise<Buffer | null> {
  const canonical = await canonicalImageFolder(folder);
  if (canonical === null) return null;
  const path = join(canonical, name);
  // O_NOFOLLOW closes the lstat/open race for the final path component.
  const handle = await _transcriptImagesDeps.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    // Verify containment and identity AFTER open, before consuming any bytes.
    const resolved = await _transcriptImagesDeps.realpath(path);
    if (dirname(resolved) !== canonical || (await canonicalImageFolder(folder)) !== canonical) return null;
    const opened = await handle.stat();
    const current = await _transcriptImagesDeps.lstat(path);
    if (!opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) return null;
    return await _transcriptImagesDeps.readFile(handle);
  } finally {
    await handle.close();
  }
}

async function readStoredImage(folder: string, image: StoredImage): Promise<ImageAttachment | null> {
  const { ref, ...metadata } = image;
  // Validate both fields before deriving a path or touching the filesystem.
  if (typeof ref !== "string" || !/^[a-f0-9]{64}$/.test(ref) || !Object.hasOwn(extensions, image.mimeType)) {
    return null;
  }
  try {
    const bytes = await readImageBytes(folder, `${ref}.${extensions[image.mimeType]}`);
    return bytes === null ? null : { ...metadata, data: bytes.toString("base64") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return null;
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
