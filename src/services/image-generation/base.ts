/**
 * Base interface for image generation providers
 *
 * Implementations wrap specific third-party APIs (fal, replicate, etc.)
 * while exposing a consistent business-level interface.
 */

import type {
  ImageGenerationRequest,
  ImageGenerationResult,
} from "./types.js";

/**
 * Abstract base class for image generation providers
 *
 * Each provider (fal, replicate, etc.) implements this interface.
 * The factory returns appropriate instances based on configuration.
 */
export abstract class ImageGenerationProvider {
  /**
   * Unique identifier for this provider
   */
  abstract readonly providerId: string;

  /**
   * Generate an image from a text prompt
   *
   * @param request - Image generation request
   * @returns Promise resolving to generation result
   * @throws ImageGenerationError if generation fails
   */
  abstract generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;

  /**
   * Check if this provider is properly configured
   */
  abstract isConfigured(): boolean;
}
