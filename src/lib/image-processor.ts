/**
 * Image downscaler — the image guardrail for `jira_read_attachment`.
 *
 * Image token cost is driven by DIMENSIONS, not base64 byte length, so capping
 * the longest edge (~1568px) is what bounds an image's context cost — not any
 * byte limit. This is the one place that decode/resize/re-encode happens.
 *
 * It sits behind an injectable {@link ImageProcessor} seam for two reasons:
 *   1. handler tests stay offline and deterministic with a fake processor (no
 *      real decode), exactly like the `IJiraClient` seam; and
 *   2. the real, jimp-backed implementation gets its own direct unit test
 *      (decode + downscale a generated image) without a live JIRA.
 *
 * jimp is a PURE-JS image library (no native binary), chosen deliberately over
 * sharp: this server ships via npx and a `.mcpb` bundle, where a native,
 * per-platform prebuilt binary is the classic packaging failure. jimp is loaded
 * lazily (dynamic import) so startup stays light and the dependency is only
 * touched when an image is actually read. If decode fails (corrupt/unsupported
 * bytes), `downscale` throws and the tool degrades VISIBLY to a can't-process
 * note — it never inlines a raw, unbounded-dimension original.
 */

export interface DownscaleInput {
  data: Buffer;
  /** The attachment's mime type (from metadata, not the media redirect). */
  mimeType: string;
}

export interface DownscaleResult {
  /** The image bytes to inline — downscaled+re-encoded, or the original if already small. */
  data: Buffer;
  /** The mime type of `data` (may differ from the input when re-encoded). */
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  /** True when the dimensions were actually reduced. */
  downscaled: boolean;
}

export interface ImageProcessor {
  /**
   * Decode `input`, scale so the longest edge is ≤ `maxEdge`, and re-encode.
   * When the image is already within `maxEdge`, returns the ORIGINAL bytes
   * untouched (`downscaled:false`). Throws when the bytes can't be decoded.
   */
  downscale(input: DownscaleInput, maxEdge: number): Promise<DownscaleResult>;
}

/** Mime types jimp can ENCODE; anything else is re-encoded as PNG (lossless). */
const JIMP_WRITABLE = new Set(["image/png", "image/jpeg", "image/bmp", "image/tiff", "image/gif"]);

function outputMime(inputMime: string): "image/png" | "image/jpeg" | "image/bmp" | "image/tiff" | "image/gif" {
  const mime = (inputMime || "").toLowerCase();
  return (JIMP_WRITABLE.has(mime) ? mime : "image/png") as
    | "image/png"
    | "image/jpeg"
    | "image/bmp"
    | "image/tiff"
    | "image/gif";
}

/** The real, jimp-backed processor used in production. */
export const jimpImageProcessor: ImageProcessor = {
  async downscale(input, maxEdge) {
    const { Jimp } = await import("jimp");
    const img = await Jimp.read(input.data);
    const originalWidth = img.width;
    const originalHeight = img.height;
    const longest = Math.max(originalWidth, originalHeight);

    if (longest <= maxEdge) {
      // Already within budget — inline the ORIGINAL bytes untouched (no needless
      // re-encode, no quality loss). Dimensions are already bounded.
      return {
        data: input.data,
        mimeType: input.mimeType,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        downscaled: false,
      };
    }

    const scale = maxEdge / longest;
    img.scale(scale);
    const mime = outputMime(input.mimeType);
    const data = Buffer.from(await img.getBuffer(mime));
    return {
      data,
      mimeType: mime,
      originalWidth,
      originalHeight,
      width: img.width,
      height: img.height,
      downscaled: true,
    };
  },
};
