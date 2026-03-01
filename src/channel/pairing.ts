import fs from "node:fs";
import path from "node:path";
import type { ChannelType, PairingConfig, PairingRequest, PairingStore } from "./types.js";

const DEFAULT_CODE_LENGTH = 8;
const DEFAULT_EXPIRES_AFTER_SEC = 3600;
const DEFAULT_MAX_PENDING_PER_CHANNEL = 3;

const AMBIGUOUS_CHARS = new Set(["0", "O", "1", "I"]);
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  .split("")
  .filter((c) => !AMBIGUOUS_CHARS.has(c))
  .join("");

function generateCode(length: number): string {
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    chars.push(CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]);
  }
  return chars.join("");
}

interface PersistedAllowEntry {
  senderId: string;
  approvedAt: string;
}

interface PersistedPairingEntry {
  code: string;
  channelType: ChannelType;
  senderId: string;
  senderName: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * File-backed PairingStore.
 *
 * Storage layout (mirrors OpenClaw convention):
 *   <stateDir>/<channelType>-pairing.json   → pending pairing requests
 *   <stateDir>/<channelType>-allowFrom.json → approved sender IDs
 */
export class FilePairingStore implements PairingStore {
  private readonly stateDir: string;
  private readonly codeLength: number;
  private readonly expiresAfterSec: number;
  private readonly maxPendingPerChannel: number;

  private readonly pendingByChannel = new Map<ChannelType, PersistedPairingEntry[]>();
  private readonly approvedByChannel = new Map<ChannelType, Set<string>>();

  constructor(config?: PairingConfig) {
    this.stateDir = config?.stateDir || path.join(process.env.HOME || "~", ".openpocket", "credentials");
    this.codeLength = config?.codeLength ?? DEFAULT_CODE_LENGTH;
    this.expiresAfterSec = config?.expiresAfterSec ?? DEFAULT_EXPIRES_AFTER_SEC;
    this.maxPendingPerChannel = config?.maxPendingPerChannel ?? DEFAULT_MAX_PENDING_PER_CHANNEL;

    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  createPairing(
    channelType: ChannelType,
    senderId: string,
    senderName: string | null,
  ): PairingRequest | null {
    this.pruneExpired(channelType);

    const pending = this.getPending(channelType);

    const existing = pending.find((p) => p.senderId === senderId);
    if (existing) {
      return {
        code: existing.code,
        channelType: existing.channelType,
        senderId: existing.senderId,
        senderName: existing.senderName,
        createdAt: existing.createdAt,
        expiresAt: existing.expiresAt,
      };
    }

    if (pending.length >= this.maxPendingPerChannel) {
      return null;
    }

    const now = new Date();
    const entry: PersistedPairingEntry = {
      code: generateCode(this.codeLength),
      channelType,
      senderId,
      senderName,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.expiresAfterSec * 1000).toISOString(),
    };

    pending.push(entry);
    this.persistPending(channelType);

    return {
      code: entry.code,
      channelType: entry.channelType,
      senderId: entry.senderId,
      senderName: entry.senderName,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    };
  }

  approvePairing(channelType: ChannelType, code: string): boolean {
    this.pruneExpired(channelType);
    const pending = this.getPending(channelType);
    const upperCode = code.toUpperCase();
    const idx = pending.findIndex((p) => p.code === upperCode);
    if (idx < 0) {
      return false;
    }

    const entry = pending[idx];
    pending.splice(idx, 1);
    this.persistPending(channelType);

    this.addToAllowlist(channelType, entry.senderId);
    return true;
  }

  rejectPairing(channelType: ChannelType, code: string): boolean {
    this.pruneExpired(channelType);
    const pending = this.getPending(channelType);
    const upperCode = code.toUpperCase();
    const idx = pending.findIndex((p) => p.code === upperCode);
    if (idx < 0) {
      return false;
    }

    pending.splice(idx, 1);
    this.persistPending(channelType);
    return true;
  }

  listPending(channelType?: ChannelType): PairingRequest[] {
    const channels: ChannelType[] = channelType
      ? [channelType]
      : ([...this.pendingByChannel.keys()] as ChannelType[]);

    const results: PairingRequest[] = [];
    for (const ct of channels) {
      this.pruneExpired(ct);
      for (const entry of this.getPending(ct)) {
        results.push({
          code: entry.code,
          channelType: entry.channelType,
          senderId: entry.senderId,
          senderName: entry.senderName,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
        });
      }
    }
    return results;
  }

  isApproved(channelType: ChannelType, senderId: string): boolean {
    const approved = this.getApproved(channelType);
    return approved.has(senderId);
  }

  addToAllowlist(channelType: ChannelType, senderId: string): void {
    const approved = this.getApproved(channelType);
    approved.add(senderId);
    this.persistApproved(channelType);
  }

  isAllowlistEmpty(channelType: ChannelType): boolean {
    return this.getApproved(channelType).size === 0;
  }

  listApproved(channelType: ChannelType): string[] {
    return [...this.getApproved(channelType)];
  }

  // --- Internal helpers ---

  private pairingFilePath(channelType: ChannelType): string {
    return path.join(this.stateDir, `${channelType}-pairing.json`);
  }

  private allowFilePath(channelType: ChannelType): string {
    return path.join(this.stateDir, `${channelType}-allowFrom.json`);
  }

  private getPending(channelType: ChannelType): PersistedPairingEntry[] {
    const freshData = this.loadPending(channelType);
    this.pendingByChannel.set(channelType, freshData);
    return freshData;
  }

  private getApproved(channelType: ChannelType): Set<string> {
    const freshData = this.loadApproved(channelType);
    this.approvedByChannel.set(channelType, freshData);
    return freshData;
  }

  private loadPending(channelType: ChannelType): PersistedPairingEntry[] {
    const filePath = this.pairingFilePath(channelType);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed as PersistedPairingEntry[];
      }
      return [];
    } catch {
      return [];
    }
  }

  private loadApproved(channelType: ChannelType): Set<string> {
    const filePath = this.allowFilePath(channelType);
    if (!fs.existsSync(filePath)) {
      return new Set();
    }
    try {
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(
          (parsed as PersistedAllowEntry[])
            .map((e) => (typeof e === "string" ? e : e.senderId))
            .filter(Boolean),
        );
      }
      return new Set();
    } catch {
      return new Set();
    }
  }

  private persistPending(channelType: ChannelType): void {
    const filePath = this.pairingFilePath(channelType);
    const entries = this.pendingByChannel.get(channelType) ?? [];
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
    } catch {
      // Ignore persistence errors — pairing degrades gracefully to in-memory.
    }
  }

  private persistApproved(channelType: ChannelType): void {
    const filePath = this.allowFilePath(channelType);
    const approved = this.approvedByChannel.get(channelType) ?? new Set();
    const entries: PersistedAllowEntry[] = [...approved].map((senderId) => ({
      senderId,
      approvedAt: new Date().toISOString(),
    }));
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
    } catch {
      // Ignore persistence errors.
    }
  }

  private pruneExpired(channelType: ChannelType): void {
    const pending = this.getPending(channelType);
    const now = Date.now();
    const before = pending.length;
    const filtered = pending.filter((entry) => {
      const expires = Date.parse(entry.expiresAt);
      return Number.isFinite(expires) && expires > now;
    });
    if (filtered.length !== before) {
      this.pendingByChannel.set(channelType, filtered);
      this.persistPending(channelType);
    }
  }
}
