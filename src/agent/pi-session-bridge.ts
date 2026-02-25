import {
  createAgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "@mariozechner/pi-coding-agent";

import {
  normalizePiSessionEvent,
  type PiSessionBridgeEvent,
} from "./pi-session-events.js";

type AgentSessionLike = CreateAgentSessionResult["session"];
type CreateSessionLike = (options?: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;

export interface PiSessionBridgeOptions {
  createSession?: CreateSessionLike;
  createOptions?: CreateAgentSessionOptions;
}

export interface PiSessionBridge {
  sessionId: string;
  sessionFile?: string;
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
  subscribeRaw: (listener: (event: AgentSessionEvent) => void) => () => void;
  subscribeNormalized: (listener: (event: PiSessionBridgeEvent) => void) => () => void;
}

function createBridge(session: AgentSessionLike): PiSessionBridge {
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    prompt: async (text: string) => {
      await session.prompt(text);
    },
    abort: async () => {
      await session.abort();
    },
    dispose: () => {
      session.dispose();
    },
    subscribeRaw: (listener: (event: AgentSessionEvent) => void) => {
      return session.subscribe(listener);
    },
    subscribeNormalized: (listener: (event: PiSessionBridgeEvent) => void) => {
      return session.subscribe((event) => {
        const normalized = normalizePiSessionEvent(event);
        if (normalized) {
          listener(normalized);
        }
      });
    },
  };
}

export async function createPiSessionBridge(
  options: PiSessionBridgeOptions = {},
): Promise<PiSessionBridge> {
  const createSession = options.createSession ?? createAgentSession;
  const result = await createSession(options.createOptions);
  return createBridge(result.session);
}
