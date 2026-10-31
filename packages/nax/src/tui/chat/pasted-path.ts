/**
 * Whether a chunk pasted into the prompt is an image file's path, and which file it names.
 *
 * A terminal pastes a dragged or copied file as text — a bare path, a `file://` URL, or the
 * shell-escaped or quoted spelling of one — so the prompt receives it as an ordinary key
 * chunk. The chat screen asks this module before inserting anything: a chunk that names an
 * image is attached (and read) instead of typed, and every other chunk stays text.
 *
 * The parse is **pure**: nothing here touches the filesystem, and it never throws, because it
 * runs inside the input's key handler where a throw would take the screen down. Whether the
 * path exists and really holds an image is decided later, by reading it.
 */
import { resolve } from "node:path";

/** The extensions nax can read — sniffed from the bytes once the file is read, not trusted here. */
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;

/** A chunk starting with this is a URL, and its path comes from the URL rather than the text. */
const FILE_URL_PREFIX = "file://";

/** The quote pairs a path may arrive wrapped in — a drag from Finder quotes a spaced name. */
const QUOTES: readonly string[] = ["'", '"'];

/** Any break: a chunk spanning more than one line is a multi-file paste, not one path. */
const NEWLINE = /[\r\n]/;

/**
 * Each `\x` backslash escape becomes `x` — how a shell-escaped path arrives. A trailing
 * lone backslash has nothing to escape and keeps itself. One pass, so an escaped backslash
 * (`\\`) becomes one backslash rather than re-escaping the character after it.
 */
const BACKSLASH_ESCAPE = /\\([\s\S])/g;

/** The chunk without one pair of matching quotes; a single unmatched quote is kept. */
function unquote(text: string): string {
  if (text.length < 2) return text;
  const quote = QUOTES.find((candidate) => text.startsWith(candidate) && text.endsWith(candidate));
  return quote === undefined ? text : text.slice(1, -1);
}

/** The pathname a `file://` URL names, percent-decoded, or undefined when it names none. */
function fileUrlPath(text: string): string | undefined {
  try {
    return decodeURIComponent(new URL(text).pathname);
  } catch {
    // Not a URL, or a `%` escape that is not valid percent-encoding: the chunk is not a path.
    return undefined;
  }
}

/**
 * The absolute path an image-file chunk names, or undefined when it names something else.
 * The chunk is trimmed, so a pasted `…png \n` (a line copied from a terminal) still counts;
 * a chunk with a newline inside it is several pasted things and is refused. A relative path
 * is resolved against `cwd`; an absolute one is kept as it is.
 */
export function pastedImagePath(chunk: string, cwd: string): string | undefined {
  const trimmed = chunk.trim();
  if (trimmed === "" || NEWLINE.test(trimmed)) return undefined;
  const text = unquote(trimmed);
  const path = text.startsWith(FILE_URL_PREFIX) ? fileUrlPath(text) : text.replace(BACKSLASH_ESCAPE, "$1");
  if (path === undefined || !IMAGE_EXTENSION.test(path)) return undefined;
  return resolve(cwd, path);
}
