import type { ImageAttachment } from "#src/cost/standard-types";

/** Supported encodings; dimensions are supplied by callers, not decoded here. */
export const IMAGE_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const MAX_IMAGES_PER_MESSAGE = 10;
/** Base64 characters per image (5 MiB encoded, 3.75 MiB raw). */
export const MAX_IMAGE_BASE64_CHARS = 5_242_880;
export const MAX_REQUEST_IMAGES = 20;
/** Base64 characters per model request and per send. */
export const MAX_REQUEST_IMAGE_BASE64_CHARS = 20_971_520;
export const IMAGE_TOKEN_ESTIMATE = 1_600;

export type SendInput = { readonly images?: readonly ImageAttachment[] };

function validateImage(image: ImageAttachment): string | undefined {
  if (!IMAGE_MIME_TYPES.includes(image.mimeType)) {
    return `Unsupported image MIME type: ${JSON.stringify(image.mimeType)}`;
  }
  if (image.data.length === 0) return "Image data is empty";
  if (image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
    return "Image data is not base64";
  }
  if (image.data.length > MAX_IMAGE_BASE64_CHARS) {
    return `Image data exceeds the per-image limit of ${MAX_IMAGE_BASE64_CHARS} base64 characters`;
  }
  for (const dimension of ["width", "height"] as const) {
    const value = image[dimension];
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      return `Image ${dimension} must be a positive integer`;
    }
  }
  return undefined;
}

/** Return the first failure, in count, image order, then total-size order. */
export function validateImageAttachments(images: readonly ImageAttachment[]): string | undefined {
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    return `Image count exceeds the limit of ${MAX_IMAGES_PER_MESSAGE} images per message`;
  }
  let total = 0;
  for (const image of images) {
    const reason = validateImage(image);
    if (reason !== undefined) return reason;
    total += image.data.length;
  }
  if (total > MAX_REQUEST_IMAGE_BASE64_CHARS) {
    return `Image data exceeds the total limit of ${MAX_REQUEST_IMAGE_BASE64_CHARS} base64 characters`;
  }
  return undefined;
}
