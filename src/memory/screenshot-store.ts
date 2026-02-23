import fs from "node:fs";
import path from "node:path";

import { ensureDir, nowForFilename } from "../utils/paths.js";

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 48);
}

export class ScreenshotStore {
  private readonly directory: string;
  private readonly maxCount: number;

  constructor(directory: string, maxCount: number) {
    this.directory = ensureDir(directory);
    this.maxCount = Math.max(1, maxCount);
  }

  save(buffer: Buffer, metadata: { sessionId: string; step: number; currentApp: string }): string {
    const appName = safeName(metadata.currentApp || "unknown");
    const filename = `${nowForFilename()}-session-${metadata.sessionId}-step-${String(
      metadata.step,
    ).padStart(3, "0")}-${appName}.png`;
    const filePath = path.join(this.directory, filename);
    fs.writeFileSync(filePath, buffer);
    this.cleanupOldFiles();
    return filePath;
  }

  cleanupOldFiles(): void {
    const files = fs
      .readdirSync(this.directory)
      .filter((name) => name.endsWith(".png"))
      .map((name) => {
        const fullPath = path.join(this.directory, name);
        const stat = fs.statSync(fullPath);
        return {
          path: fullPath,
          mtimeMs: stat.mtimeMs,
        };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    const extra = files.length - this.maxCount;
    if (extra <= 0) {
      return;
    }

    for (let i = 0; i < extra; i += 1) {
      try {
        fs.unlinkSync(files[i].path);
      } catch {
        // Ignore cleanup failures for best-effort retention control.
      }
    }
  }

  listLatest(limit = 20): string[] {
    return fs
      .readdirSync(this.directory)
      .filter((name) => name.endsWith(".png"))
      .map((name) => path.join(this.directory, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, Math.max(1, limit));
  }
}
