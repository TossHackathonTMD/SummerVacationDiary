/**
 * Remembers drawings the AI friend already made, keyed by the bytes of the
 * originally selected file.
 *
 * Why the original file and not the cropped result: `react-easy-crop` rounds
 * the crop rectangle to integers, so re-cropping "the same way" by hand is
 * never byte-identical twice and a key built from the cropped JPEG would
 * practically never match. Hashing the source file matches whenever the same
 * photo is picked again, which is the case worth catching — a re-drawn photo
 * costs one of the user's limited credits.
 *
 * Only the sketch is stored, never the photo. The two together would be roughly
 * 700 KB per entry against a ~5 MB origin budget that the diary draft already
 * shares, and the draft losing its save is a far worse failure than a cache
 * miss.
 */

const STORAGE_KEY = "summer-vacation-diary:sketch-cache:v1";
const MAX_ENTRIES = 3;

interface CacheEntry {
  /** SHA-256 hex digest of the original file's bytes. */
  key: string;
  sketchDataUrl: string;
}

function isEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { key, sketchDataUrl } = value as Record<string, unknown>;
  return (
    typeof key === "string" &&
    key !== "" &&
    typeof sketchDataUrl === "string" &&
    sketchDataUrl !== ""
  );
}

/** Oldest first, so the least recently used entry is always at index 0. */
function readEntries(): CacheEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isEntry).slice(-MAX_ENTRIES);
  } catch {
    // Corrupt JSON or storage denied entirely (private browsing): behave as an
    // empty cache rather than breaking photo selection.
    return [];
  }
}

function writeEntries(entries: CacheEntry[]): void {
  // Shed the oldest entry and retry instead of giving up on the first failure.
  // This cache shares the origin's quota with the diary draft, so it has to be
  // the thing that yields.
  let candidates = entries;
  while (candidates.length > 0) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(candidates));
      return;
    } catch {
      candidates = candidates.slice(1);
    }
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage is unavailable; the cache simply does nothing this session.
  }
}

/**
 * Hashes the picked file. Returns null when Web Crypto is unavailable — it
 * needs a secure context, which the Toss WebView (https) and localhost both
 * provide, but a plain-http dev server on a LAN IP does not. A null hash
 * disables the cache for that photo and changes nothing else.
 */
export async function hashPhotoFile(file: File): Promise<string | null> {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    return null;
  }
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return null;
  }
}

export function getCachedSketch(key: string | null): string | null {
  if (key === null) {
    return null;
  }
  const entries = readEntries();
  const index = entries.findIndex((entry) => entry.key === key);
  if (index === -1) {
    return null;
  }
  // Touch on read so the eviction order reflects use, not just insertion.
  const [entry] = entries.splice(index, 1);
  entries.push(entry);
  writeEntries(entries);
  return entry.sketchDataUrl;
}

/**
 * Drops a drawing the user chose to replace, so the reuse dialog can never
 * offer it again. Discarding on the choice rather than when the new drawing
 * arrives is deliberate: keeping it would mean a failed redraw silently
 * resurrects the picture the user just replaced.
 */
export function removeCachedSketch(key: string | null): void {
  if (key === null) {
    return;
  }
  const entries = readEntries();
  const remaining = entries.filter((entry) => entry.key !== key);
  if (remaining.length === entries.length) {
    return;
  }
  writeEntries(remaining);
}

export function putCachedSketch(
  key: string | null,
  sketchDataUrl: string,
): void {
  if (key === null) {
    return;
  }
  const entries = readEntries().filter((entry) => entry.key !== key);
  entries.push({ key, sketchDataUrl });
  writeEntries(entries.slice(-MAX_ENTRIES));
}
