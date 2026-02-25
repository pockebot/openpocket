/**
 * fal.ai provider for image generation
 *
 * Implements image generation using fal.ai's REST API.
 * Supports various models including nanobanana.
 */

import type {
  ImageGenerationRequest,
  ImageGenerationResult,
} from "./types.js";
import { ImageGenerationProvider } from "./base.js";
import { ImageGenerationError } from "./types.js";

/**
 * Configuration for fal provider
 */
export interface FalProviderConfig {
  /** fal.ai API key */
  apiKey: string;
  /** Model to use (default: nanobanana) */
  model?: string;
  /** API base URL (default: fal.ai queue) */
  baseUrl?: string;
}

/**
 * fal.ai API response structure
 */
interface FalQueueResponse {
  request_id: string;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
}

interface FalResultResponse {
  images: Array<{
    url: string;
    width: number;
    height: number;
  }>;
}

/**
 * Image generation provider using fal.ai
 */
export class FalProvider extends ImageGenerationProvider {
  readonly providerId = "fal";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: FalProviderConfig) {
    super();
    this.apiKey = config.apiKey;
    this.model = config.model ?? "fal-ai/nano-banana";
    this.baseUrl = config.baseUrl ?? "https://queue.fal.run";
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (!this.isConfigured()) {
      throw new ImageGenerationError(
        "fal provider is not configured (missing API key)",
        this.providerId,
      );
    }

    try {
      const modelEndpoint = this.model.replace(/^fal-ai\//, "");
      const queueUrl = `${this.baseUrl}/${this.model}`;

      // Step 1: Submit request to queue
      // eslint-disable-next-line no-console
      console.log(`[FalProvider] Submitting request to ${queueUrl}`);

      const queueResponse = await fetch(queueUrl, {
        method: "POST",
        headers: {
          "Authorization": `Key ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: request.prompt,
        }),
      });

      if (!queueResponse.ok) {
        const errorText = await queueResponse.text();
        throw new Error(`HTTP ${queueResponse.status}: ${errorText}`);
      }

      const queueData: FalQueueResponse = await queueResponse.json();

      if (queueData.status === "COMPLETED") {
        // Some models complete synchronously
        const resultData = await queueResponse.json() as FalResultResponse;
        if (!resultData.images || resultData.images.length === 0) {
          throw new Error("No images in response");
        }
        return {
          url: resultData.images[0].url,
          provider: this.providerId,
          metadata: { model: this.model },
        };
      }

      // Step 2: Poll for result (async queue)
      const requestId = queueData.request_id;
      const statusUrl = `${this.baseUrl}/${this.model}/requests/${requestId}/status`;

      let attempts = 0;
      const maxAttempts = 60; // 60 seconds timeout
      const pollInterval = 1000; // 1 second

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        const statusResponse = await fetch(statusUrl, {
          headers: {
            "Authorization": `Key ${this.apiKey}`,
          },
        });

        if (!statusResponse.ok) {
          throw new Error(`Status check failed: HTTP ${statusResponse.status}`);
        }

        const statusData: FalQueueResponse = await statusResponse.json();

        if (statusData.status === "COMPLETED") {
          // Fetch final result
          const resultUrl = `${this.baseUrl}/${this.model}/requests/${requestId}`;
          const resultResponse = await fetch(resultUrl, {
            headers: {
              "Authorization": `Key ${this.apiKey}`,
            },
          });

          if (!resultResponse.ok) {
            throw new Error(`Failed to fetch result: HTTP ${resultResponse.status}`);
          }

          const resultData: FalResultResponse = await resultResponse.json();

          if (!resultData.images || resultData.images.length === 0) {
            throw new Error("No images in response");
          }

          return {
            url: resultData.images[0].url,
            provider: this.providerId,
            metadata: {
              model: this.model,
              requestId,
            },
          };
        }

        if (statusData.status === "IN_QUEUE" || statusData.status === "IN_PROGRESS") {
          attempts++;
          continue;
        }

        throw new Error(`Unexpected status: ${statusData.status}`);
      }

      throw new Error("Request timed out");
    } catch (error) {
      if (error instanceof ImageGenerationError) {
        throw error;
      }
      throw new ImageGenerationError(
        `Failed to generate image: ${error instanceof Error ? error.message : String(error)}`,
        this.providerId,
        error,
      );
    }
  }
}
