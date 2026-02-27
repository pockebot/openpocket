/**
 * Image generation service factory and exports
 *
 * Provides business-level image generation functionality,
 * abstracting away the underlying provider implementation.
 */

import type { ImageGenerationRequest, ImageGenerationResult } from "./types.js";
import { ImageGenerationProvider } from "./base.js";
import { FalProvider, type FalProviderConfig } from "./fal-provider.js";

// Re-export types for convenience
export type {
  ImageGenerationRequest,
  ImageGenerationResult,
} from "./types.js";
export { ImageGenerationError } from "./types.js";
export { ImageGenerationProvider } from "./base.js";
export { FalProvider, type FalProviderConfig } from "./fal-provider.js";

/**
 * Supported provider types
 */
export type ImageProviderType = "fal";

/**
 * Configuration for creating an image generation provider
 */
export interface ImageProviderConfig {
  type: ImageProviderType;
  apiKey: string;
  model?: string;
}

/**
 * Create an image generation provider based on type
 *
 * @param config - Provider configuration
 * @returns Configured provider instance
 * @throws Error if provider type is unsupported
 */
export function createImageProvider(config: ImageProviderConfig): ImageGenerationProvider {
  switch (config.type) {
    case "fal":
      return new FalProvider({
        apiKey: config.apiKey,
        model: config.model,
      });
  }
  // If we add more providers in the future, TypeScript will catch missing cases
  throw new Error(`Unsupported image provider type: ${config.type}`);
}

/**
 * Image generation service (convenience facade)
 *
 * Wraps a provider and provides a simple generate interface.
 */
export class ImageGenerationService {
  private readonly provider: ImageGenerationProvider;

  constructor(provider: ImageGenerationProvider) {
    this.provider = provider;
  }

  /**
   * Generate an image from a text prompt
   *
   * @param prompt - Text description of the image
   * @returns Promise resolving to generation result
   */
  async generate(prompt: string): Promise<ImageGenerationResult> {
    return this.provider.generate({ prompt });
  }

  /**
   * Check if the service is properly configured
   */
  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  /**
   * Get the provider identifier
   */
  getProviderId(): string {
    return this.provider.providerId;
  }
}

/**
 * Create an image generation service from configuration
 *
 * @param config - Provider configuration
 * @returns Configured service instance
 */
export function createImageService(config: ImageProviderConfig): ImageGenerationService {
  const provider = createImageProvider(config);
  return new ImageGenerationService(provider);
}
