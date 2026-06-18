/**
 * lessbytes — perceptual (SSIM-guided) browser image compression.
 */

export type LessBytesFormat = 'auto' | 'jpeg' | 'jpg' | 'webp' | 'png' | 'avif';

export interface CompressOptions {
  /** Output format. `'auto'` competes AVIF/WebP/JPEG and keeps the smallest that passes the SSIM gate (PNG kept if transparent). Default `'auto'`. */
  format?: LessBytesFormat;
  /** Candidate formats tried in `'auto'` mode, best-compression-first. Default `['avif','webp','jpeg']`. */
  autoCandidates?: LessBytesFormat[];
  /** Target perceptual quality as SSIM (0..1). `0.992` ≈ visually lossless. Default `0.992`. */
  targetSSIM?: number;
  /** Lower bound for the encoder quality search (0..1). Default `0.4`. */
  minQuality?: number;
  /** Upper bound for the encoder quality search (0..1). Default `0.96`. */
  maxQuality?: number;
  /** Binary-search iterations. Default `7`. */
  searchSteps?: number;
  /** Max output width in px (preserves aspect ratio, never upscales). */
  maxWidth?: number | null;
  /** Max output height in px (preserves aspect ratio, never upscales). */
  maxHeight?: number | null;
  /** Hard file-size budget in bytes. When set, overrides SSIM mode. */
  targetSize?: number | null;
  /** Background color used when flattening transparency into a lossy format. Default `'#ffffff'`. */
  background?: string;
  /** Downsample size used for the SSIM computation. Default `320`. */
  ssimSampleSize?: number;
  /** If the result is not smaller than the source, return the original. Default `true`. */
  keepSmallest?: boolean;
}

export interface CompressResult {
  /** The compressed image data. */
  blob: Blob;
  /** Output width in px. */
  width: number;
  /** Output height in px. */
  height: number;
  /** Output format actually used. */
  format: string;
  /** Encoder quality used (0..1). */
  quality: number;
  /** Measured SSIM of the result vs. the source (0..1). */
  ssim: number;
  /** Original file size in bytes (0 if unknown). */
  originalSize: number;
  /** Output size in bytes. */
  size: number;
  /** Size reduction ratio (0..1), e.g. 0.72 == 72% smaller. */
  ratio: number;
  /** True if the original was smaller and was returned unchanged. */
  keptOriginal: boolean;
  /** Resolve the output as a base64 data URL. */
  toDataURL(): Promise<string>;
  /** Wrap the output as a File (falls back to Blob where File is unavailable). */
  toFile(name?: string): File | Blob;
}

export interface BatchOptions extends CompressOptions {
  /** Max images processed in parallel. Default `3`. */
  concurrency?: number;
  /** Progress callback fired after each image completes. */
  onProgress?: (done: number, total: number, lastResult: CompressResult | { error: Error; input: unknown }) => void;
}

export type ImageInput = Blob | File | HTMLImageElement | string;

export const version: string;
export const defaults: Required<CompressOptions>;

/** Compress a single image. */
export function compress(input: ImageInput, options?: CompressOptions): Promise<CompressResult>;

/** Compress many images with bounded concurrency. */
export function compressBatch(
  inputs: ImageInput[],
  options?: BatchOptions
): Promise<Array<CompressResult | { error: Error; input: ImageInput }>>;

/** Compute mean SSIM between two equally-sized ImageData buffers (0..1). */
export function computeSSIM(reference: ImageData, comparison: ImageData): number;

/** Detect whether the browser can encode a given mime type via canvas. */
export function isFormatSupported(mime: string): boolean;

declare const lessbytes: {
  version: string;
  compress: typeof compress;
  compressBatch: typeof compressBatch;
  computeSSIM: typeof computeSSIM;
  isFormatSupported: typeof isFormatSupported;
  defaults: Required<CompressOptions>;
};

export default lessbytes;
