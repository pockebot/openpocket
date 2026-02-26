import type { ChannelType, DmPolicy, PairingStore } from "./types.js";

export interface DmPolicyCheckResult {
  allowed: boolean;
  /** When policy is "pairing" and sender is unknown, a new pairing code is created. */
  pairingCode?: string;
  reason: string;
}

export interface DmPolicyEngineOptions {
  policy: DmPolicy;
  allowFrom: string[];
  pairingStore: PairingStore;
  channelType: ChannelType;
}

/**
 * Evaluate whether an inbound DM sender is allowed under the configured policy.
 *
 * Policy behavior:
 *   - "open"      → always allowed
 *   - "disabled"   → always denied
 *   - "allowlist"  → allowed only if senderId is in the static allowFrom list
 *                     OR has been approved via pairing
 *   - "pairing"    → same as allowlist, but unknown senders are offered a
 *                     one-time pairing code for owner approval
 */
export function evaluateDmPolicy(
  senderId: string,
  senderName: string | null,
  options: DmPolicyEngineOptions,
): DmPolicyCheckResult {
  const { policy, allowFrom, pairingStore, channelType } = options;

  if (policy === "disabled") {
    return { allowed: false, reason: "dm_policy_disabled" };
  }

  if (policy === "open") {
    return { allowed: true, reason: "dm_policy_open" };
  }

  const inStaticAllowlist =
    allowFrom.length === 0 || allowFrom.includes("*") || allowFrom.includes(senderId);

  if (inStaticAllowlist) {
    return { allowed: true, reason: "allowlist_match" };
  }

  if (pairingStore.isApproved(channelType, senderId)) {
    return { allowed: true, reason: "pairing_approved" };
  }

  if (policy === "allowlist") {
    return { allowed: false, reason: "not_in_allowlist" };
  }

  // policy === "pairing": create a pairing request for the unknown sender
  const request = pairingStore.createPairing(channelType, senderId, senderName);
  if (!request) {
    return { allowed: false, reason: "pairing_limit_reached" };
  }

  return {
    allowed: false,
    pairingCode: request.code,
    reason: "pairing_code_issued",
  };
}
