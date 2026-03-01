import type { InboundEnvelope, SessionKeyResolver } from "./types.js";

/**
 * Default session key resolver.
 *
 * Key shapes:
 *   DM:     "agent:main:main"              (all DMs collapse to one session)
 *   Group:  "agent:main:<channel>:group:<peerId>"
 *   Thread: "agent:main:<channel>:group:<peerId>:topic:<threadId>"
 */
export class DefaultSessionKeyResolver implements SessionKeyResolver {
  private readonly agentId: string;

  constructor(agentId = "main") {
    this.agentId = agentId;
  }

  resolve(envelope: InboundEnvelope): string {
    if (envelope.peerKind === "dm") {
      return `agent:${this.agentId}:main`;
    }

    const base = `agent:${this.agentId}:${envelope.channelType}:group:${envelope.peerId}`;

    if (envelope.peerKind === "thread" && envelope.threadId) {
      return `${base}:topic:${envelope.threadId}`;
    }

    return base;
  }
}
