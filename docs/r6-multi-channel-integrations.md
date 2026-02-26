# R6. Multi-Channel Control Integrations

Date: 2026-02-26
Branch: `feature/r6-multi-channel-integrations`
Status: **Planning**

## Goal

Go beyond Telegram and support more communication entry points — including Discord, WhatsApp, iMessage, Messenger, WeChat, and QQ — through a unified channel abstraction for message, auth, and task control.

## OpenClaw Reference Study

Before designing our own abstraction, we studied [OpenClaw](https://docs.openclaw.ai) — an open-source personal AI agent platform that already ships production-grade multi-channel support for 15+ platforms (Telegram, WhatsApp, Discord, Slack, Signal, iMessage, Matrix, IRC, LINE, Feishu, Google Chat, MS Teams, etc.). Key takeaways below.

> Note: OpenPocket already uses some OpenClaw primitives internally (`SessionOpenclawStoreBackend`, skill metadata `openclaw.requires` / `openclaw.triggers`). The multi-channel design should stay compatible with these.

### OpenClaw Architecture Summary

```
┌────────────────────────────────────────────────────────────┐
│                     Gateway (daemon)                       │
│  Single long-lived process owning all messaging surfaces   │
│  Typed WS API (req/res/events) for clients + nodes         │
│  JSON Schema-based protocol (TypeBox)                      │
└──────┬─────────────────────────────────────────┬───────────┘
       │                                         │
  ┌────▼────┐                              ┌─────▼──────┐
  │ Channels │                              │   Nodes    │
  │ (chat)   │                              │ (devices)  │
  │ telegram │                              │ iOS/macOS  │
  │ whatsapp │                              │ Android    │
  │ discord  │                              │ headless   │
  │ slack    │                              └────────────┘
  │ signal   │
  │ imessage │
  │ ...      │
  └──────────┘
```

### Key Design Decisions We Should Adopt

**1. DM Access Policy System (Pairing)**

OpenClaw's access control is NOT a simple allowlist. It offers 4 DM policies per channel:

| Policy | Behavior |
|--------|----------|
| `pairing` (default) | Unknown senders get 8-char code, owner must approve |
| `allowlist` | Only pre-configured senders |
| `open` | All inbound DMs allowed (requires `allowFrom: ["*"]`) |
| `disabled` | Block all inbound DMs |

Why this matters for OpenPocket: Our current `allowedChatIds` is hardcoded allowlist-only. The pairing model lets new users onboard without config file editing — they message the bot, get a code, and the owner approves via any existing channel or CLI.

**2. Auto-Start Channels by Config Presence**

OpenClaw starts a channel automatically when its config section exists (unless `enabled: false`). No explicit `channels.enabled: ["telegram", "discord"]` array needed. This is cleaner — adding a channel = adding its config block.

**3. Deterministic Reply Routing**

Replies always go back to the originating channel. The model does NOT choose which channel to reply on. This avoids confusion and keeps sessions scoped.

**4. Session Key Shapes**

Sessions are keyed hierarchically:

- DM: `agent:<agentId>:<sessionScope>` (DMs collapse to main session)
- Group: `agent:<agentId>:<channel>:group:<groupId>`
- Thread: `agent:<agentId>:<channel>:channel:<channelId>:thread:<threadId>`

This isolates conversations per context while allowing cross-channel DMs to share state.

**5. Group Policy Layer**

Separate from DM policy, groups have their own access control:

- Group allowlist (which groups the bot responds in)
- Sender allowlist within groups
- Mention-gating (require `@bot` mention, configurable per group)
- Activation mode (always / mention-only, switchable per session)

**6. Channel-Specific Features via Capabilities**

- WhatsApp: ack reactions, read receipts, text chunking (`length` vs `newline` mode), media size limits, self-chat protections, multi-account
- Discord: slash commands, guild+role permissions, thread tracking, embed formatting
- Each channel has its own config structure rather than forcing a lowest-common-denominator

**7. Pairing State Storage**

- DM pairing: `~/.openclaw/credentials/<channel>-pairing.json` (pending) + `<channel>-allowFrom.json` (approved)
- Device pairing: `~/.openclaw/devices/paired.json` + `pending.json`
- Pairing codes: 8 chars, uppercase, no ambiguous chars (`0O1I`), expire 1 hour, cap 3 pending per channel

**8. WhatsApp Uses Baileys**

OpenClaw chose Baileys (WhatsApp Web) over `whatsapp-web.js`. Gateway owns the Baileys session directly. Supports multi-account with per-account auth dirs.

### Gaps Between OpenClaw and OpenPocket

| Aspect | OpenClaw | OpenPocket (current) |
|--------|----------|---------------------|
| Core purpose | Personal AI assistant (chat/tools) | Phone agent (emulator control + tasks) |
| Channel count | 15+ production channels | Telegram only |
| Access control | Pairing + allowlist + open + disabled | `allowedChatIds` hardcoded |
| Protocol | WS gateway + typed frames | Direct Telegram polling |
| Session model | Multi-agent routing with bindings | Single-agent, single-channel |
| Phone control | Nodes (iOS/Android via WS) | Direct ADB + emulator manager |
| Human auth | N/A (tools-based) | HumanAuthBridge + relay + ngrok |

OpenPocket has unique requirements OpenClaw doesn't cover:

- **Phone task lifecycle**: progress narration, step screenshots, agent run results — these need channel-aware delivery
- **Human-auth relay**: approval links, delegation artifacts, screenshot-in-prompt — must work cross-channel
- **Emulator management commands**: `/startvm`, `/stopvm`, `/screen` — device-control commands that no chat platform natively needs
- **Cron task dispatch**: tasks triggered by cron jobs must route results to the originating or configured channel

---

## Current Architecture Analysis

### Existing Gateway Structure

```
src/gateway/
├── telegram-gateway.ts   ← monolithic, ~2560 lines, Telegram-specific
├── chat-assistant.ts     ← AI conversation/prompting (model-agnostic, reusable)
├── cron-service.ts       ← scheduled task runner (channel-agnostic)
├── heartbeat-runner.ts   ← health monitoring (channel-agnostic)
└── run-loop.ts           ← process lifecycle (channel-agnostic)
```

### Key Observations

1. **`TelegramGateway`** is a 2500+ line monolith that directly couples Telegram SDK (`node-telegram-bot-api`) with core business logic (task dispatching, progress narration, user decisions, human-auth relay, command routing, cron execution).

2. **Already channel-agnostic modules** that can be reused as-is:
   - `ChatAssistant` — LLM conversation, prompt assembly, onboarding, narration
   - `CronService` — cron job scheduling and execution
   - `HeartbeatRunner` — health/stuck-task checks
   - `runGatewayLoop()` — process lifecycle and signal handling
   - `AgentRuntime` — phone agent task execution
   - `EmulatorManager` — device control

3. **Tightly coupled Telegram concepts** that must be abstracted:
   - Message sending (text, photo, markdown formatting)
   - Command parsing (`/start`, `/help`, `/screen`, etc.)
   - Chat ID based access control (`allowedChatIds`)
   - Typing indicators
   - User decision/input prompt-reply lifecycle
   - Bot display name sync
   - Polling-based message loop

4. **Config dependency**: `OpenPocketConfig.telegram` is the only channel config; no generic channel concept exists yet.

## Core Architecture Design

### Design Principles (informed by OpenClaw study)

1. **Config-driven auto-start**: A channel starts when its config block is present. No separate `enabled` array.
2. **Pairing-first access**: Default DM policy is `pairing` (code approval). Replaces hardcoded `allowedChatIds`.
3. **Deterministic reply routing**: Replies go back to the originating channel. No model-driven channel selection.
4. **Session-per-context**: Session keys encode channel + context type (DM / group / thread) to isolate conversations.
5. **Capability-aware delivery**: GatewayCore checks channel capabilities before sending (e.g. no inline buttons on WhatsApp → fall back to numbered list).
6. **Backward-compatible**: Existing `config.telegram` with `allowedChatIds` continues to work, mapped to `allowlist` policy internally.

### Layer Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    User / Client                         │
│   Telegram │ Discord │ WhatsApp │ WeChat │ ...           │
└──────┬──────┬────────┬─────────┬────────┬───────────────┘
       │      │        │         │        │
       ▼      ▼        ▼         ▼        ▼
┌─────────────────────────────────────────────────────────┐
│           Channel Adapter (per-platform)                 │
│  SDK init, auth, message format, polling/webhook         │
│  Pairing code generation + pending store                 │
│  Platform-native command mapping                         │
└──────────────────────┬──────────────────────────────────┘
                       │  implements ChannelAdapter
                       ▼
┌─────────────────────────────────────────────────────────┐
│           Channel Layer (R6-T1)                          │
│  ChannelAdapter interface                                │
│  ChannelRouter (multi-channel dispatch + reply routing)  │
│  InboundEnvelope (unified inbound message/command type)  │
│  DM policy engine (pairing / allowlist / open / disabled)│
│  Session key resolver (channel + context → session key)  │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│             Gateway Core (refactored)                    │
│  ChatAssistant, CronService, HeartbeatRunner             │
│  AgentRuntime, HumanAuthBridge, EmulatorManager          │
│  Command handler registry (platform-agnostic)            │
│  Task dispatch queue + progress narration router         │
└─────────────────────────────────────────────────────────┘
```

### Key Interfaces (Draft v2 — post-OpenClaw study)

```typescript
// --- DM access policy (from OpenClaw pattern) ---

type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
type GroupPolicy = "allowlist" | "open" | "disabled";

interface PairingRequest {
  code: string;               // 8 chars, uppercase, no ambiguous 0O1I
  channelType: ChannelType;
  senderId: string;
  senderName: string | null;
  createdAt: string;
  expiresAt: string;           // 1 hour TTL
}

// --- Channel Adapter: each platform implements this ---

interface ChannelAdapter {
  readonly channelType: ChannelType;

  start(): Promise<void>;
  stop(): Promise<void>;

  sendText(peerId: string, text: string, opts?: SendOptions): Promise<void>;
  sendImage(peerId: string, imagePath: string, caption?: string): Promise<void>;
  sendActionPrompt(peerId: string, prompt: UserActionPrompt): Promise<UserActionResponse>;

  onInbound(handler: InboundHandler): void;

  setTypingIndicator(peerId: string, active: boolean): Promise<void>;
  resolveDisplayName(peerId: string): Promise<string | null>;

  getCapabilities(): ChannelCapabilities;
  getDmPolicy(): DmPolicy;
}

// --- Unified inbound envelope (inspired by OpenClaw) ---

type ChannelType = "telegram" | "discord" | "whatsapp" | "wechat" | "qq"
                 | "signal" | "slack";

interface InboundEnvelope {
  channelType: ChannelType;
  senderId: string;            // platform-specific user ID
  senderName: string | null;
  peerId: string;              // DM = senderId, group = groupId
  peerKind: "dm" | "group" | "thread";
  threadId?: string;           // Discord/Telegram thread/topic
  text: string;
  command?: string;            // normalized command name (without prefix)
  commandArgs?: string;
  attachments?: Attachment[];
  replyTo?: ReplyContext;      // quoted message context
  rawEvent: unknown;
  receivedAt: string;
}

interface ReplyContext {
  messageId: string;
  senderId: string;
  body: string;
}

// --- Channel capabilities ---

interface ChannelCapabilities {
  supportsMarkdown: boolean;
  supportsInlineButtons: boolean;
  supportsReactions: boolean;
  supportsImageUpload: boolean;
  supportsTypingIndicator: boolean;
  supportsSlashCommands: boolean;
  supportsThreads: boolean;
  supportsDisplayNameSync: boolean;
  maxMessageLength: number;
  textChunkMode?: "length" | "newline";
}

// --- Session key resolver ---

interface SessionKeyResolver {
  resolve(envelope: InboundEnvelope): string;
  // DM:     "agent:main:main"
  // Group:  "agent:main:<channel>:group:<peerId>"
  // Thread: "agent:main:<channel>:group:<peerId>:topic:<threadId>"
}

// --- User action prompt/response ---

interface UserActionPrompt {
  type: "decision" | "input" | "auth_approval";
  question: string;
  options?: string[];
  placeholder?: string;
  timeoutSec: number;
  screenshotPath?: string | null;
}

interface UserActionResponse {
  selectedOption?: string;
  text?: string;
  approved?: boolean;
  resolvedAt: string;
}

// --- Channel router: multi-channel orchestrator ---

interface ChannelRouter {
  register(adapter: ChannelAdapter): void;
  getAdapter(channelType: ChannelType): ChannelAdapter | null;
  getAllAdapters(): ChannelAdapter[];

  // Deterministic reply routing: always reply on originating channel
  replyText(envelope: InboundEnvelope, text: string): Promise<void>;
  replyImage(envelope: InboundEnvelope, imagePath: string, caption?: string): Promise<void>;

  // Pairing management (cross-channel)
  listPendingPairings(channelType?: ChannelType): PairingRequest[];
  approvePairing(channelType: ChannelType, code: string): boolean;
}
```

### Config Extension (Draft v2)

```jsonc
// ~/.openpocket/config.json
{
  // --- existing telegram config stays for backward compat ---
  "telegram": {
    "botToken": "...",
    "allowedChatIds": [123456]    // mapped to allowlist policy internally
  },

  // --- new multi-channel config ---
  // each block auto-starts the channel (unless enabled: false)
  "channels": {
    "defaults": {
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist"
    },

    "telegram": {
      "botToken": "...",
      "botTokenEnv": "TELEGRAM_BOT_TOKEN",
      "dmPolicy": "pairing",
      "allowFrom": ["tg:123456789"],
      "groups": {
        "*": { "requireMention": true }
      }
    },

    "discord": {
      "token": "",
      "tokenEnv": "DISCORD_BOT_TOKEN",
      "dmPolicy": "pairing",
      "allowFrom": [],
      "guilds": {
        "SERVER_ID": {
          "requireMention": true,
          "users": ["USER_ID"]
        }
      }
    },

    "whatsapp": {
      "dmPolicy": "pairing",
      "allowFrom": ["+15551234567"],
      "textChunkLimit": 4000,
      "chunkMode": "length",
      "sendReadReceipts": true
    },

    "wechat": {
      "enabled": false
    }
  },

  // --- pairing state storage ---
  "pairing": {
    "codeLength": 8,
    "expiresAfterSec": 3600,
    "maxPendingPerChannel": 3,
    "stateDir": "~/.openpocket/credentials"
  }
}
```

### Migration Path

| Current Config | New Config | Behavior |
|----------------|------------|----------|
| `telegram.allowedChatIds: [123]` | `channels.telegram.dmPolicy: "allowlist"` + `allowFrom: ["tg:123"]` | Identical — allowlist-based filtering |
| `telegram.botToken` | `channels.telegram.botToken` | Identical |
| (no channels block) | (absent) | Legacy `telegram` block used directly, backward compatible |

When both `telegram` (legacy) and `channels.telegram` exist, `channels.telegram` takes precedence with a deprecation warning.

## Task Breakdown

### R6-T1: Channel Abstraction Layer

**Goal**: Define and implement the core abstraction interfaces + refactor `TelegramGateway` into `TelegramAdapter` + `GatewayCore`.

**Sub-tasks**:

- [ ] Define `ChannelAdapter`, `ChannelRouter`, `InboundEnvelope`, and related types in `src/channel/types.ts`
- [ ] Implement DM policy engine (`pairing` / `allowlist` / `open` / `disabled`) in `src/channel/dm-policy.ts`
- [ ] Implement pairing code generation + pending store in `src/channel/pairing.ts`
- [ ] Implement `SessionKeyResolver` in `src/channel/session-keys.ts`
- [ ] Define `ChannelCapabilities` per-platform feature matrix in `src/channel/capabilities.ts`
- [ ] Extract platform-agnostic logic from `TelegramGateway` into `src/gateway/gateway-core.ts`
  - command handler registry (decouple from Telegram command parsing)
  - task dispatch and queue logic
  - progress narration dispatch (capability-aware)
  - user decision/input lifecycle
  - human-auth relay bridge
  - chat context store
- [ ] Implement `TelegramAdapter` in `src/channel/telegram/adapter.ts` wrapping existing Telegram SDK logic
- [ ] Implement `ChannelRouter` in `src/channel/router.ts` with deterministic reply routing
- [ ] Extend `OpenPocketConfig` and `src/types.ts` with channel config + migration logic
- [ ] Add `openclaw pairing list/approve` equivalent CLI commands to `openpocket`
- [ ] Update `gateway start` CLI entry point to bootstrap via `ChannelRouter`
- [ ] Ensure all existing Telegram tests pass with the refactored adapter
- [ ] Add unit tests for `ChannelRouter`, `GatewayCore`, DM policy engine, and pairing

### R6-T2: Discord Connector

**Goal**: Implement `DiscordAdapter` so users can control OpenPocket from Discord DMs or a designated guild channel.

**Status**: Done (2026-02-26)

**Sub-tasks**:

- [x] Add `discord.js` dependency (v14)
- [x] Implement `DiscordAdapter` in `src/channel/discord/adapter.ts`
  - Bot login and ready lifecycle
  - Message content intent + privileged intents setup (GatewayIntentBits)
  - DM and guild message parsing → `InboundEnvelope`
  - Text + image sending (AttachmentBuilder, EmbedBuilder)
  - Typing indicator (sendTyping)
  - User decision prompts via Discord buttons (ActionRowBuilder + ButtonBuilder)
  - User input prompts via text flow
  - Human auth escalation via embeds with link buttons
  - Thread tracking (threadId in envelope for PublicThread/PrivateThread)
  - Text chunking for messages > 2000 chars
  - HTML to Discord markdown conversion
- [x] Implement guild + role-based access control (`guilds` config)
  - Per-guild user allowlist
  - `requireMention` flag (defaults to true)
- [x] Wire into `gateway-factory.ts` with `isDiscordConfigured` auto-detection
- [x] Unit tests: 15 adapter tests + 5 factory integration tests
- [ ] Slash command registration (deferred — text commands work via the same pipeline)
- [ ] Integration test: send task via Discord, receive progress and result
- [ ] Document Discord bot setup (app creation, intents, permissions, invite URL)

### R6-T3: WhatsApp Connector

**Goal**: Implement `WhatsAppAdapter` using Baileys (WhatsApp Web), following OpenClaw's proven approach.

**Sub-tasks**:

- [ ] Add `baileys` dependency (same library OpenClaw uses in production)
- [ ] Implement `WhatsAppAdapter` in `src/channel/whatsapp/adapter.ts`
  - QR-code based session linking (`openclaw channels login` equivalent)
  - Baileys socket lifecycle + reconnect loop
  - Message receive/send normalization
  - Image/media sending with size limits
  - Read receipt support (configurable)
  - Text chunking (length / newline modes)
  - Self-chat protections for personal-number setups
  - User decision via numbered-reply text flow
- [ ] Implement WhatsApp session persistence and credential storage
- [ ] Add multi-account support (per-account auth dir, config overrides)
- [ ] Add WhatsApp-specific config schema
- [ ] Add `openpocket channels login --channel whatsapp` CLI command
- [ ] Document setup flow (QR scan, dedicated vs. personal number)
- [ ] Note compliance/TOS considerations (recommend dedicated number)

### R6-T4: WeChat/QQ Connector Research

**Goal**: Research feasibility and design adapter stubs for China-focused platforms.

**Status**: Research complete (2026-02-26). See detailed findings below.

**Sub-tasks**:

- [x] Survey available WeChat bot/automation libraries and their limitations
- [x] Survey QQ bot options
- [x] Write feasibility report with recommended approach per platform
- [ ] Design `WeChatAdapter` / `QQAdapter` interface stubs
- [ ] Identify auth and compliance requirements for each platform

---

#### WeChat (微信) — Feasibility Report

There are **3 distinct routes**, each targeting a different WeChat surface:

##### Route A: Personal WeChat via Wechaty + PadLocal (推荐起步方案)

| Item | Detail |
|------|--------|
| Library | [Wechaty](https://github.com/wechaty/wechaty) v1.20.2 (TypeScript, 22K stars, actively maintained) |
| Protocol | iPad protocol via [PadLocal](https://wechaty.js.org/docs/puppet-services/padlocal) puppet service |
| Why not Web API | WeChat blocked Web API login for accounts registered after 2017 — `itchat` and similar are dead |
| Token | 7-day free trial at pad-local.com; paid long-term token required (price undisclosed, contact vendor); or earn free token via Wechaty Contributor Program (submit merged PR) |
| Capabilities | Text send/receive, image, file, contact card, room (group) management, friend request auto-accept |
| Limitations | No red packets / transfers / payments; no URL rich media messages; no official account operation; personal accounts only |
| Risk | **High** — WeChat may block iPad protocol at any time (as they did with Web API). Account ban possible under heavy automation. No SLA. |
| OpenClaw status | **Not supported** — OpenClaw does not have a WeChat channel. We'd be pioneering. |
| Deployment | Wechaty gateway runs as Node.js process; PadLocal token connects to a remote protocol bridge server |

```typescript
// Wechaty usage example
import { WechatyBuilder } from 'wechaty'

const bot = WechatyBuilder.build({ puppet: 'wechaty-puppet-padlocal', puppetOptions: { token: '...' } })
bot.on('message', async (msg) => {
  if (msg.text() === 'hello') await msg.say('Hi from OpenPocket!')
})
await bot.start()
```

**Verdict**: Viable for MVP / personal use. Not suitable for production guarantees. The paid token dependency and protocol ban risk make this the most fragile option.

##### Route B: Enterprise WeChat (企业微信/WeCom) via Official API

| Item | Detail |
|------|--------|
| API | [企业微信开发者中心](https://developer.work.weixin.qq.com/) — official, stable |
| Auth | CorpID + AgentID + SECRET; message callback requires public webhook URL |
| Capabilities | Text, markdown, card messages, image, file; receive messages via encrypted callback (AES); supports group chats within the enterprise |
| Limitations | **Enterprise-only** — requires a registered enterprise account; users must be in the same enterprise or be external contacts; not usable for personal WeChat contacts |
| Callback requirements | Must respond within 3 seconds; needs public URL (ngrok/tunnel compatible); message encryption/decryption (EncodingAESKey) |
| Risk | **Low** — officially supported, no ban risk |
| OpenClaw status | Not supported natively; `WorkPro` puppet exists in Wechaty but is Beta |

**Verdict**: Most stable WeChat option, but audience is limited to enterprise users. Good fit if OpenPocket targets corporate/team deployment. Not suitable for personal consumer use.

##### Route C: WeChat Work Webhook (企业微信群机器人)

| Item | Detail |
|------|--------|
| Type | Group webhook robot (one-way push only by default) |
| Capabilities | Send text, markdown, image, file to a group via webhook URL |
| Limitations | **One-way only** — can send TO group but cannot RECEIVE messages. Requires Route B's callback API for bidirectional communication. Only works within enterprise WeChat groups. |
| Risk | **Low** |

**Verdict**: Not sufficient alone (can't receive messages). Useful only as notification channel, not as control surface.

##### WeChat Recommendation

| Priority | Route | Use Case |
|----------|-------|----------|
| 1st | **Route A (Wechaty + PadLocal)** | Personal WeChat users, MVP, experimentation |
| 2nd | **Route B (Enterprise WeChat API)** | Enterprise/team deployments with stability requirements |
| Skip | Route C (Webhook) | Notification only, not a control channel |

Start with Route A for broadest reach, plan Route B as stable enterprise alternative.

---

#### QQ — Feasibility Report

There are **2 distinct routes**:

##### Route A: QQ Official Bot API (QQ 官方机器人) — 受限但安全

| Item | Detail |
|------|--------|
| API | [QQ 机器人官方文档](https://bot.q.qq.com/wiki/) |
| SDK | [`qq-official-bot`](https://www.npmjs.com/package/qq-official-bot) (TypeScript) or official Node SDK |
| Registration | Free at [QQ Open Platform](https://q.qq.com/) — individuals can register |
| Capabilities | C2C private chat, guild channel messages, guild DMs |
| Modes | WebSocket (deprecated) or Webhook (recommended) |
| Rate limits | **Severe**: 200 active messages/day total; 2 active messages/user/day; passive replies must be within 5 minutes |
| Group support | **No QQ group (QQ 群) support** — only guild channels (QQ 频道) and private chat via "message list" config |
| Sandbox | Can be used without publishing (sandbox debugging mode) |
| Risk | **None** — officially supported |

**Critical limitation**: The official API does NOT support traditional QQ groups (QQ 群). It only supports QQ guilds (频道), which have much smaller adoption. The rate limits also make it unsuitable for anything beyond light personal use.

##### Route B: NapCat + OneBot v11 (非官方, 全功能) — 推荐

| Item | Detail |
|------|--------|
| Framework | [NapCat](https://github.com/NapNeko/NapCatQQ) — based on NTQQ, implements OneBot v11 |
| Alternatives | Lagrange (another OneBot v11 impl) |
| Protocol | OneBot v11 (standardized, framework-agnostic) |
| Capabilities | **Full QQ feature set**: group chats, private chats, guild channels, images, voice, video, file, reactions |
| Deployment | Docker (recommended), Windows native, or alongside NTQQ desktop client |
| Connection | WebSocket (NapCat runs WS server on port 3001, our adapter connects as client) |
| OpenClaw status | **Production-ready plugin exists**: `@creatoraris/openclaw-qq` and `@sliverp/qqbot` — both use NapCat + OneBot v11 |
| Features proven | Media send/receive, @mention triggers, user/group allowlist, message deduplication, auto start/stop |
| Risk | **Medium** — unofficial, account ban possible by Tencent. NapCat depends on NTQQ client internals. |

```typescript
// OneBot v11 WebSocket connection example
const ws = new WebSocket('ws://localhost:3001')
ws.on('message', (data) => {
  const event = JSON.parse(data)
  if (event.post_type === 'message') {
    // event.message_type: 'private' | 'group'
    // event.raw_message: string
    // event.user_id, event.group_id
    ws.send(JSON.stringify({
      action: 'send_msg',
      params: { message_type: event.message_type, user_id: event.user_id, group_id: event.group_id, message: 'Hi from OpenPocket!' }
    }))
  }
})
```

##### QQ Recommendation

| Priority | Route | Use Case |
|----------|-------|----------|
| **1st** | **Route B (NapCat + OneBot v11)** | Full QQ group + private chat support; OpenClaw has proven this works |
| 2nd | Route A (Official API) | Guild-only scenarios with rate limit tolerance |

Route B is strongly recommended. The official API's lack of QQ group support and severe rate limits make it impractical for a phone agent control channel. OpenClaw's existing QQ plugins validate this approach.

---

#### Combined WeChat/QQ Implementation Strategy

```
Phase 1 (with R6-T1):
  └── Design adapter stubs for both platforms

Phase 2 (after T1 stable):
  ├── QQAdapter via NapCat/OneBot v11     ← lower risk, proven by OpenClaw
  │   - OneBot v11 is a standard protocol, well-documented
  │   - WebSocket client connection (not server)
  │   - OpenClaw plugins provide reference implementation
  │
  └── WeChatAdapter via Wechaty/PadLocal  ← higher risk, no prior art
      - Requires paid PadLocal token
      - Protocol ban risk
      - More complex setup (QR scan + token + bridge server)

Phase 3 (optional enterprise track):
  └── WeCom adapter via official API       ← stable but enterprise-only
```

#### Dependency Summary

| Platform | Library | Protocol | npm Package | Risk |
|----------|---------|----------|-------------|------|
| QQ (recommended) | NapCat | OneBot v11 (WS) | — (raw WS client) | Medium |
| QQ (official) | qq-official-bot | QQ Official API | `qq-official-bot` | None |
| WeChat (personal) | Wechaty | iPad (PadLocal) | `wechaty` + `wechaty-puppet-padlocal` | High |
| WeCom (enterprise) | Official SDK | HTTP callback | `@wecom/bot` or raw HTTP | None |

## Implementation Priority and Dependencies

```
R6-T1 (abstraction layer + pairing engine)
  ├── R6-T2 (Discord)        ← can start after T1 interfaces are stable
  ├── R6-T3 (WhatsApp)       ← can start after T1 interfaces are stable
  └── R6-T4 (WeChat/QQ)      ← research can start in parallel with T1
```

R6-T1 is the critical path. T2/T3 are parallelizable after T1 core is merged. T4 is research-only and can proceed independently.

## Proposed File Structure

```
src/channel/
├── types.ts                    # ChannelAdapter, InboundEnvelope, ChannelCapabilities, etc.
├── router.ts                   # ChannelRouter: multi-channel dispatch + deterministic reply
├── dm-policy.ts                # DM policy engine (pairing/allowlist/open/disabled)
├── pairing.ts                  # Pairing code generation, pending store, approve/reject
├── session-keys.ts             # SessionKeyResolver: envelope → session key
├── capabilities.ts             # Per-platform capability matrix
├── telegram/
│   ├── adapter.ts              # TelegramAdapter implements ChannelAdapter
│   └── format.ts               # Telegram MarkdownV2/HTML formatting
├── discord/
│   ├── adapter.ts              # DiscordAdapter implements ChannelAdapter
│   ├── commands.ts             # Slash command registration + mapping
│   └── format.ts               # Discord embed formatting
├── whatsapp/
│   ├── adapter.ts              # WhatsAppAdapter implements ChannelAdapter (Baileys)
│   ├── session.ts              # Baileys auth persistence + reconnect
│   └── normalize.ts            # Message normalization (media placeholders, contacts, etc.)
└── wechat/
    └── adapter-stub.ts         # Interface stub (T4 output)

src/gateway/
├── gateway-core.ts             # Extracted platform-agnostic orchestration logic
├── chat-assistant.ts           # (unchanged)
├── cron-service.ts             # (unchanged)
├── heartbeat-runner.ts         # (unchanged)
├── run-loop.ts                 # (unchanged)
└── telegram-gateway.ts         # Deprecated thin wrapper → delegates to channel/telegram/adapter.ts
```

## Progress Tracker

| Task | Status | Notes |
|------|--------|-------|
| OpenClaw reference study | Done | Pairing, routing, config patterns adopted into v2 design |
| WeChat/QQ feasibility research | Done | See R6-T4 section for full report |
| R6-T1: Channel abstraction layer | **Done** | All stages completed with unit tests |
|   T1-S1: Core types (types.ts) | Done | ChannelAdapter, InboundEnvelope, ChannelCapabilities, ChannelRouter, etc. |
|   T1-S2: DM Policy + Pairing (dm-policy.ts, pairing.ts) | Done | evaluateDmPolicy, FilePairingStore with file-backed persistence |
|   T1-S3: SessionKeys + Router + Capabilities | Done | DefaultSessionKeyResolver, DefaultChannelRouter, per-channel caps |
|   T1-S4: GatewayCore extraction (gateway-core.ts) | Done | Platform-agnostic orchestration: commands, task queue, progress narration |
|   T1-S5: TelegramAdapter (channel/telegram/adapter.ts) | Done | Full ChannelAdapter impl: polling, typing, user decision/input, auth escalation |
|   T1-S6: Config + Factory + Integration | Done | channels/pairing in OpenPocketConfig, createGateway factory |
| R6-T2: Discord connector | **Done** | DiscordAdapter implemented with full ChannelAdapter interface |
|   T2: discord.js v14 dependency | Done | discord.js added to package.json |
|   T2: DiscordAdapter impl | Done | DM + Guild message parsing, embeds, buttons, typing, access control |
|   T2: Gateway factory wiring | Done | isDiscordConfigured + auto-register in createGateway |
|   T2: Unit tests | Done | 15 adapter tests + 5 factory tests (26 total Discord-related) |
| R6-T3: WhatsApp connector (Baileys) | Not started | Depends on T1 (completed) |
| R6-T4: WeChat/QQ adapter stubs | Not started | Research done; NapCat/OneBot for QQ, Wechaty/PadLocal for WeChat |

## Risk and Considerations

- **TelegramGateway refactor scope**: The 2500+ line monolith requires careful extraction. Must ensure zero regression for existing Telegram users. Legacy `config.telegram` must keep working.
- **Pairing UX design**: Need to decide how pairing approvals work when there's no existing channel (cold start). CLI-based approval is the fallback.
- **WhatsApp TOS**: Baileys is unofficial WhatsApp Web automation. OpenClaw uses it in production at scale, which de-risks the choice, but account bans remain possible. Recommend dedicated number.
- **WeChat restrictions**: WeChat has increasingly restricted unofficial bot interfaces. Official WeChat Work API is more viable but limited to enterprise accounts. OpenClaw does not support WeChat — we'd be pioneering.
- **Message format divergence**: Different platforms support different formatting (Markdown, embeds, buttons). The abstraction must handle graceful degradation via `ChannelCapabilities`.
- **Auth model differences**: Telegram uses chatId, Discord uses guild/role, WhatsApp uses phone numbers. The pairing + DM policy system unifies this at the policy layer while keeping per-platform identity formats.
- **Session isolation**: Cross-channel DMs sharing a main session is convenient but could leak context. Need clear documentation on session scoping behavior.
- **Testing**: Each connector needs unit tests (mocked SDK) + manual integration tests (real accounts). OpenClaw's testing approach (doctor command + channel status CLI) is worth adopting.
