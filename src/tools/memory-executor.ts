import fs from "node:fs";
import path from "node:path";

import type { AgentAction, OpenPocketConfig } from "../types.js";

type MemorySearchAction = Extract<AgentAction, { type: "memory_search" }>;
type MemoryGetAction = Extract<AgentAction, { type: "memory_get" }>;

type MemorySearchHit = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  citation: string;
};

function tokenizeForSearch(input: string): string[] {
  const normalized = String(input || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  return normalized.split(" ").filter((token) => token.length > 1);
}

function formatCitation(filePath: string, startLine: number, endLine: number): string {
  if (startLine === endLine) {
    return `${filePath}#L${startLine}`;
  }
  return `${filePath}#L${startLine}-L${endLine}`;
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export class MemoryExecutor {
  private readonly config: OpenPocketConfig;

  constructor(config: OpenPocketConfig) {
    this.config = config;
  }

  private resolveWorkspacePath(inputPath: string): string {
    const raw = String(inputPath || "").trim();
    if (!raw) {
      throw new Error("memory_get: path is required.");
    }
    const resolved = path.resolve(this.config.workspaceDir, raw);
    const relative = path.relative(this.config.workspaceDir, resolved).replace(/\\/g, "/");
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`memory_get: path escapes workspace (${raw}).`);
    }
    const lower = relative.toLowerCase();
    const isMemoryRoot = lower === "memory.md";
    const isMemorySubPath = lower.startsWith("memory/");
    if (!isMemoryRoot && !isMemorySubPath) {
      throw new Error("memory_get: only MEMORY.md and memory/*.md are allowed.");
    }
    return resolved;
  }

  private resolveDisplayPath(absolutePath: string): string {
    const relative = path.relative(this.config.workspaceDir, absolutePath).replace(/\\/g, "/");
    return relative || path.basename(absolutePath);
  }

  private listMemoryFiles(): string[] {
    const files: string[] = [];
    const rootMemory = path.join(this.config.workspaceDir, "MEMORY.md");
    if (fs.existsSync(rootMemory) && fs.statSync(rootMemory).isFile()) {
      files.push(rootMemory);
    }

    const memoryDir = path.join(this.config.workspaceDir, "memory");
    if (!fs.existsSync(memoryDir) || !fs.statSync(memoryDir).isDirectory()) {
      return files;
    }

    const stack = [memoryDir];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          files.push(full);
        }
      }
    }

    return files;
  }

  private scoreSnippet(snippet: string, query: string, queryTokens: string[]): number {
    const normalizedSnippet = String(snippet || "").toLowerCase();
    if (!normalizedSnippet.trim()) {
      return 0;
    }
    const phraseScore = query && normalizedSnippet.includes(query) ? 0.5 : 0;
    if (queryTokens.length === 0) {
      return phraseScore > 0 ? phraseScore : 0.2;
    }
    let matched = 0;
    for (const token of queryTokens) {
      if (normalizedSnippet.includes(token)) {
        matched += 1;
      }
    }
    const coverage = matched / queryTokens.length;
    return clamp(phraseScore + coverage * 0.5, 0, 1);
  }

  private searchMemory(action: MemorySearchAction): string {
    if (!this.config.memoryTools.enabled) {
      return JSON.stringify(
        {
          results: [],
          disabled: true,
          warning: "memoryTools is disabled by config.",
        },
        null,
        2,
      );
    }

    const rawQuery = String(action.query ?? "").trim();
    if (!rawQuery) {
      throw new Error("memory_search: query is required.");
    }
    const query = rawQuery.toLowerCase();
    const queryTokens = tokenizeForSearch(rawQuery);
    const minScore = clamp(
      Number.isFinite(action.minScore ?? NaN)
        ? Number(action.minScore)
        : this.config.memoryTools.minScore,
      0,
      1,
    );
    const maxResults = clamp(
      Number.isFinite(action.maxResults ?? NaN)
        ? Math.round(Number(action.maxResults))
        : this.config.memoryTools.maxResults,
      1,
      30,
    );

    const files = this.listMemoryFiles();
    const hits: MemorySearchHit[] = [];
    const windowSize = 6;
    const stride = 3;

    for (const filePath of files) {
      let raw = "";
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const lines = raw.split("\n");
      const maxStart = Math.max(0, lines.length - 1);
      const fileHits: MemorySearchHit[] = [];

      for (let start = 0; start <= maxStart; start += stride) {
        const endExclusive = Math.min(lines.length, start + windowSize);
        const snippetRaw = lines.slice(start, endExclusive).join("\n").trim();
        if (!snippetRaw) {
          continue;
        }
        const score = this.scoreSnippet(snippetRaw, query, queryTokens);
        if (score < minScore) {
          continue;
        }
        const snippet = snippetRaw.length > this.config.memoryTools.maxSnippetChars
          ? `${snippetRaw.slice(0, this.config.memoryTools.maxSnippetChars)}...[truncated]`
          : snippetRaw;
        const displayPath = this.resolveDisplayPath(filePath);
        const startLine = start + 1;
        const endLine = endExclusive;
        fileHits.push({
          path: displayPath,
          startLine,
          endLine,
          score: Number(score.toFixed(3)),
          snippet,
          citation: formatCitation(displayPath, startLine, endLine),
        });
      }

      fileHits.sort((a, b) => b.score - a.score);
      hits.push(...fileHits.slice(0, 3));
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.path !== b.path) {
        return a.path.localeCompare(b.path);
      }
      return a.startLine - b.startLine;
    });

    return JSON.stringify(
      {
        query: rawQuery,
        minScore,
        scannedFiles: files.length,
        results: hits.slice(0, maxResults),
      },
      null,
      2,
    );
  }

  private getMemorySnippet(action: MemoryGetAction): string {
    if (!this.config.memoryTools.enabled) {
      return JSON.stringify(
        {
          path: String(action.path ?? ""),
          text: "",
          disabled: true,
          warning: "memoryTools is disabled by config.",
        },
        null,
        2,
      );
    }

    const resolved = this.resolveWorkspacePath(String(action.path ?? ""));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return JSON.stringify(
        {
          path: this.resolveDisplayPath(resolved),
          text: "",
          missing: true,
        },
        null,
        2,
      );
    }

    const raw = fs.readFileSync(resolved, "utf8");
    const lines = raw.split("\n");
    const from = clamp(Math.round(action.from ?? 1), 1, Math.max(1, lines.length));
    const maxLines = clamp(Math.round(action.lines ?? 120), 1, 2000);
    const start = from - 1;
    const end = Math.min(lines.length, start + maxLines);
    const text = lines.slice(start, end).join("\n");
    return JSON.stringify(
      {
        path: this.resolveDisplayPath(resolved),
        from,
        lines: end - start,
        totalLines: lines.length,
        text,
      },
      null,
      2,
    );
  }

  execute(action: AgentAction): string {
    if (action.type === "memory_search") {
      return this.searchMemory(action);
    }
    if (action.type === "memory_get") {
      return this.getMemorySnippet(action);
    }
    throw new Error(`memory executor does not support action type '${action.type}'`);
  }
}
