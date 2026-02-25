/**
 * Image generation service types
 *
 * Business-level abstraction - consumers should not need to know
 * which underlying provider (fal, replicate, etc.) is being used.
 */

/**
 * Request for image generation
 */
export interface ImageGenerationRequest {
  /** Text description of the image to generate */
  prompt: string;
}

/**
 * Result from image generation
 */
export interface ImageGenerationResult {
  /** Public URL of the generated image */
  url: string;
  /** Provider identifier (for logging/debugging) */
  provider: string;
  /** Additional provider-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Error thrown when image generation fails
 */
export class ImageGenerationError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}
