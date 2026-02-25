export type DeviceTargetType = "emulator" | "physical-phone" | "android-tv" | "cloud";

export interface DeviceTargetConfig {
  type: DeviceTargetType;
  /**
   * Optional adb endpoint used for network devices (for example: 192.168.1.8:5555).
   * Leave empty for USB-connected devices.
   */
  adbEndpoint: string;
  /**
   * Reserved for cloud integrations. Current runtime still uses adb transport.
   */
  cloudProvider: string;
}

export interface EmulatorConfig {
  avdName: string;
  androidSdkRoot: string;
  headless: boolean;
  bootTimeoutSec: number;
  /** AVD userdata partition target size in GB (for onboarding-created AVDs). */
  dataPartitionSizeGb: number;
  extraArgs: string[];
}

export interface TelegramConfig {
  botToken: string;
  botTokenEnv: string;
  allowedChatIds: number[];
  pollTimeoutSec: number;
}

export interface AgentConfig {
  maxSteps: number;
  loopDelayMs: number;
  progressReportInterval: number;
  returnHomeOnTaskEnd: boolean;
  /** Enable automatic post-task artifact generation (skills/auto + scripts/auto). */
  autoArtifactsEnabled: boolean;
  systemPromptMode: "full" | "minimal" | "none";
  /** Maximum total chars for workspace prompt context injection.
   *  Defaults to 150 000. Lower this for models with small context windows. */
  contextBudgetChars: number;
  lang: "en";
  verbose: boolean;
  deviceId: string | null;
}

export interface ScreenshotConfig {
  saveStepScreenshots: boolean;
  directory: string;
  maxCount: number;
}

export interface ScriptExecutorConfig {
  enabled: boolean;
  timeoutSec: number;
  maxOutputChars: number;
  allowedCommands: string[];
}

export interface CodingToolsConfig {
  enabled: boolean;
  workspaceOnly: boolean;
  timeoutSec: number;
  maxOutputChars: number;
  allowBackground: boolean;
  applyPatchEnabled: boolean;
  allowedCommands: string[];
}

export interface MemoryToolsConfig {
  enabled: boolean;
  maxResults: number;
  minScore: number;
  maxSnippetChars: number;
}

export interface HeartbeatConfig {
  enabled: boolean;
  everySec: number;
  stuckTaskWarnSec: number;
  writeLogFile: boolean;
}

export interface CronConfig {
  enabled: boolean;
  tickSec: number;
  jobsFile: string;
}

export interface DashboardConfig {
  enabled: boolean;
  host: string;
  port: number;
  autoOpenBrowser: boolean;
}

export interface SessionStorageConfig {
  mode: "unified";
  storePath: string;
  markdownLog: boolean;
}

export interface HumanAuthTunnelNgrokConfig {
  enabled: boolean;
  executable: string;
  authtoken: string;
  authtokenEnv: string;
  apiBaseUrl: string;
  startupTimeoutSec: number;
}

export interface HumanAuthConfig {
  enabled: boolean;
  useLocalRelay: boolean;
  localRelayHost: string;
  localRelayPort: number;
  localRelayStateFile: string;
  relayBaseUrl: string;
  publicBaseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  requestTimeoutSec: number;
  pollIntervalMs: number;
  tunnel: {
    provider: "none" | "ngrok";
    ngrok: HumanAuthTunnelNgrokConfig;
  };
}

export type HumanAuthCapability =
  | "camera"
  | "qr"
  | "microphone"
  | "voice"
  | "nfc"
  | "sms"
  | "2fa"
  | "location"
  | "biometric"
  | "notification"
  | "contacts"
  | "calendar"
  | "files"
  | "oauth"
  | "payment"
  | "permission"
  | "unknown";

export interface HumanAuthRequest {
  sessionId: string;
  sessionPath: string;
  task: string;
  step: number;
  capability: HumanAuthCapability;
  instruction: string;
  reason: string;
  timeoutSec: number;
  currentApp: string;
  screenshotPath: string | null;
}

export interface HumanAuthDecision {
  requestId: string;
  approved: boolean;
  status: "approved" | "rejected" | "timeout";
  message: string;
  decidedAt: string;
  artifactPath: string | null;
}

export interface UserDecisionRequest {
  sessionId: string;
  sessionPath: string;
  task: string;
  step: number;
  question: string;
  options: string[];
  timeoutSec: number;
  currentApp: string;
  screenshotPath: string | null;
}

export interface UserDecisionResponse {
  selectedOption: string;
  rawInput: string;
  resolvedAt: string;
}

export interface UserInputRequest {
  sessionId: string;
  sessionPath: string;
  task: string;
  step: number;
  question: string;
  placeholder?: string;
  timeoutSec: number;
  currentApp: string;
  screenshotPath: string | null;
}

export interface UserInputResponse {
  text: string;
  resolvedAt: string;
}

export interface ModelProfile {
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyEnv: string;
  maxTokens: number;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | null;
  temperature: number | null;
}

export interface OpenPocketConfig {
  projectName: string;
  workspaceDir: string;
  stateDir: string;
  sessionStorage: SessionStorageConfig;
  defaultModel: string;
  target: DeviceTargetConfig;
  emulator: EmulatorConfig;
  telegram: TelegramConfig;
  agent: AgentConfig;
  screenshots: ScreenshotConfig;
  scriptExecutor: ScriptExecutorConfig;
  codingTools: CodingToolsConfig;
  memoryTools: MemoryToolsConfig;
  heartbeat: HeartbeatConfig;
  cron: CronConfig;
  dashboard: DashboardConfig;
  humanAuth: HumanAuthConfig;
  models: Record<string, ModelProfile>;
  configPath: string;
}

export interface EmulatorStatus {
  targetType: DeviceTargetType;
  avdName: string;
  devices: string[];
  bootedDevices: string[];
}

export interface ScreenSnapshot {
  deviceId: string;
  currentApp: string;
  width: number;
  height: number;
  screenshotBase64: string;
  /** Set-of-Mark overlay image (same scaled resolution) with numbered UI boxes. */
  somScreenshotBase64: string | null;
  capturedAt: string;
  /** Multiply model X coordinates by this to get original-resolution X. */
  scaleX: number;
  /** Multiply model Y coordinates by this to get original-resolution Y. */
  scaleY: number;
  /** Width of the scaled image the model actually sees. */
  scaledWidth: number;
  /** Height of the scaled image the model actually sees. */
  scaledHeight: number;
  /** Installed launchable package names (for launch_app). */
  installedPackages?: string[];
  /** Actionable UI nodes extracted from uiautomator dump for deterministic element targeting. */
  uiElements: UiElementSnapshot[];
}

export interface UiElementSnapshot {
  id: string;
  text: string;
  contentDesc: string;
  resourceId: string;
  className: string;
  clickable: boolean;
  enabled: boolean;
  /** Original-device bounds. */
  bounds: { left: number; top: number; right: number; bottom: number };
  /** Center point in original device coordinate space. */
  center: { x: number; y: number };
  /** Bounds in model/scaled screenshot coordinate space. */
  scaledBounds: { left: number; top: number; right: number; bottom: number };
  /** Center in model/scaled screenshot coordinate space. */
  scaledCenter: { x: number; y: number };
}

export type AgentAction =
  | { type: "tap"; x: number; y: number; reason?: string }
  | { type: "tap_element"; elementId: string; reason?: string }
  | {
      type: "swipe";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      durationMs?: number;
      reason?: string;
    }
  | { type: "type"; text: string; reason?: string }
  | { type: "keyevent"; keycode: string; reason?: string }
  | { type: "launch_app"; packageName: string; reason?: string }
  | { type: "shell"; command: string; reason?: string }
  | { type: "run_script"; script: string; timeoutSec?: number; reason?: string }
  | { type: "read"; path: string; from?: number; lines?: number; reason?: string }
  | { type: "write"; path: string; content: string; append?: boolean; reason?: string }
  | { type: "edit"; path: string; find: string; replace: string; replaceAll?: boolean; reason?: string }
  | { type: "apply_patch"; input: string; reason?: string }
  | {
      type: "exec";
      command: string;
      workdir?: string;
      yieldMs?: number;
      background?: boolean;
      timeoutSec?: number;
      reason?: string;
    }
  | {
      type: "process";
      action: "list" | "poll" | "log" | "write" | "kill";
      sessionId?: string;
      input?: string;
      offset?: number;
      limit?: number;
      timeoutMs?: number;
      reason?: string;
    }
  | {
      type: "memory_search";
      query: string;
      maxResults?: number;
      minScore?: number;
      reason?: string;
    }
  | {
      type: "memory_get";
      path: string;
      from?: number;
      lines?: number;
      reason?: string;
    }
  | {
      type: "request_human_auth";
      capability: HumanAuthCapability;
      instruction: string;
      timeoutSec?: number;
      reason?: string;
    }
  | {
      type: "request_user_decision";
      question: string;
      options: string[];
      timeoutSec?: number;
      reason?: string;
    }
  | {
      type: "request_user_input";
      question: string;
      placeholder?: string;
      timeoutSec?: number;
      reason?: string;
    }
  | { type: "wait"; durationMs?: number; reason?: string }
  | { type: "finish"; message: string };

export interface ModelStepOutput {
  thought: string;
  action: AgentAction;
  raw: string;
}

export interface AgentRunResult {
  ok: boolean;
  message: string;
  sessionPath: string;
  skillPath?: string | null;
  scriptPath?: string | null;
}

export interface AgentProgressUpdate {
  step: number;
  maxSteps: number;
  currentApp: string;
  actionType: string;
  message: string;
  thought: string;
  screenshotPath: string | null;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: "workspace" | "local" | "bundled";
  path: string;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  everySec: number;
  task: string;
  chatId: number | null;
  model: string | null;
  runOnStartup: boolean;
}
