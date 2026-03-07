export type DeviceTargetType = "emulator" | "physical-phone" | "android-tv" | "cloud";

export interface DeviceTargetConfig {
  type: DeviceTargetType;
  /**
   * Optional adb endpoint used for network devices (for example: 192.168.1.8:5555).
   * Leave empty for USB-connected devices.
   */
  adbEndpoint: string;
  /**
   * Lock-screen PIN used for target auto-unlock.
   * Must be 4 digits when set.
   */
  pin: string;
  /**
   * Screen keep-awake heartbeat interval in seconds.
   */
  wakeupIntervalSec: number;
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
  /**
   * Skill format compatibility mode:
   * - `legacy`: permissive legacy markdown behavior
   * - `mixed`: support legacy + strict layouts (rollout default)
   * - `strict`: enforce strict Agent Skills-compatible layout/validation
   */
  skillsSpecMode: "legacy" | "mixed" | "strict";
  systemPromptMode: "full" | "minimal" | "none";
  /** Maximum total chars for workspace prompt context injection.
   *  Defaults to 150 000. Lower this for models with small context windows. */
  contextBudgetChars: number;
  lang: "en";
  verbose: boolean;
  deviceId: string | null;
  /**
   * Runtime backend selector for incremental migration.
   * - `legacy_agent_core`: current AgentRuntime execution path (default)
   * - `pi_session_bridge`: reserved for pi-coding-agent AgentSession bridge path
   */
  runtimeBackend?: "legacy_agent_core" | "pi_session_bridge";
  /**
   * Deprecated migration toggle.
   * When true, unsupported/erroring pi coding actions fall back to legacy CodingExecutor.
   * Default is false and this key will be removed in a future release.
   */
  legacyCodingExecutor?: boolean;
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

export type GatewayLogLevel = "error" | "warn" | "info" | "debug";

export interface GatewayLogModulesConfig {
  core: boolean;
  access: boolean;
  task: boolean;
  channel: boolean;
  cron: boolean;
  heartbeat: boolean;
  humanAuth: boolean;
  chat: boolean;
}

export interface GatewayLoggingConfig {
  level: GatewayLogLevel;
  includePayloads: boolean;
  maxPayloadChars: number;
  modules: GatewayLogModulesConfig;
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
  | "photos"
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

export type HumanAuthUiFieldType =
  | "text"
  | "textarea"
  | "password"
  | "email"
  | "number"
  | "date"
  | "select"
  | "otp"
  | "card-number"
  | "expiry"
  | "cvc";

export interface HumanAuthUiFieldOption {
  label: string;
  value: string;
}

export interface HumanAuthUiField {
  id: string;
  label: string;
  type: HumanAuthUiFieldType;
  placeholder?: string;
  required?: boolean;
  helperText?: string;
  options?: HumanAuthUiFieldOption[];
  autocomplete?: string;
  artifactKey?: string;
}

export interface HumanAuthUiStyle {
  brandColor?: string;
  backgroundCss?: string;
  fontFamily?: string;
}

export interface HumanAuthUiTemplate {
  templateId?: string;
  title?: string;
  summary?: string;
  capabilityHint?: string;
  artifactKind?: "auto" | "credentials" | "payment_card" | "form";
  requireArtifactOnApprove?: boolean;
  allowTextAttachment?: boolean;
  allowLocationAttachment?: boolean;
  allowPhotoAttachment?: boolean;
  allowAudioAttachment?: boolean;
  allowFileAttachment?: boolean;
  fileAccept?: string;
  fields?: HumanAuthUiField[];
  middleHtml?: string;
  middleCss?: string;
  middleScript?: string;
  approveScript?: string;
  approveLabel?: string;
  rejectLabel?: string;
  noteLabel?: string;
  notePlaceholder?: string;
  style?: HumanAuthUiStyle;
}

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
  uiTemplate?: HumanAuthUiTemplate;
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

export type ChannelMediaType = "auto" | "image" | "file" | "voice";

export interface ChannelMediaRequest {
  sessionId: string;
  sessionPath: string;
  task: string;
  step: number;
  path: string;
  mediaType: ChannelMediaType;
  caption?: string;
  reason?: string;
  currentApp: string;
  screenshotPath: string | null;
}

export interface ChannelMediaDeliveryResult {
  ok: boolean;
  mediaType: Exclude<ChannelMediaType, "auto"> | null;
  message: string;
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
  /** @deprecated Use channels.telegram instead */
  telegram?: TelegramConfig;
  agent: AgentConfig;
  screenshots: ScreenshotConfig;
  scriptExecutor: ScriptExecutorConfig;
  codingTools: CodingToolsConfig;
  memoryTools: MemoryToolsConfig;
  heartbeat: HeartbeatConfig;
  cron: CronConfig;
  dashboard: DashboardConfig;
  gatewayLogging: GatewayLoggingConfig;
  humanAuth: HumanAuthConfig;
  models: Record<string, ModelProfile>;
  channels: import("./channel/types.js").ChannelsConfig;
  pairing?: import("./channel/types.js").PairingConfig;
  configPath: string;
}

export interface EmulatorStatus {
  targetType: DeviceTargetType;
  avdName: string;
  devices: string[];
  bootedDevices: string[];
}

export interface ScreenSnapshotCaptureMetrics {
  totalMs: number;
  ensureReadyMs: number;
  screencapMs: number;
  screenSizeMs: number;
  currentAppMs: number;
  scaleMs: number;
  uiDumpMs: number;
  overlayMs: number;
  uiElementsSource: "fresh" | "cache" | "cache_fallback" | "fresh_empty";
  uiElementsCount: number;
  visualHash: string;
  visualHashHammingDistance: number | null;
  uiDumpTimedOut: boolean;
  secureSurfaceDetected: boolean;
  secureSurfaceEvidence: string;
}

export interface ScreenSnapshot {
  deviceId: string;
  currentApp: string;
  width: number;
  height: number;
  screenshotBase64: string;
  /** True when current focused app window includes FLAG_SECURE. */
  secureSurfaceDetected: boolean;
  /** Short dumpsys snippet proving secure surface detection (if any). */
  secureSurfaceEvidence: string;
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
  /** Per-capture timing and cache diagnostics for screenshot pipeline profiling. */
  captureMetrics?: ScreenSnapshotCaptureMetrics;
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

export type BatchableAgentAction =
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
  | {
      type: "drag";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      durationMs?: number;
      reason?: string;
    }
  | {
      type: "long_press_drag";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      holdMs?: number;
      durationMs?: number;
      reason?: string;
    }
  | { type: "type"; text: string; reason?: string }
  | { type: "keyevent"; keycode: string; reason?: string }
  | { type: "wait"; durationMs?: number; reason?: string };

export type AgentAction =
  | BatchableAgentAction
  | { type: "launch_app"; packageName: string; reason?: string }
  | {
      type: "shell";
      command: string;
      /**
       * When true, execute as `sh -lc <command>` on device.
       * Use for shell operators/heredoc/redirect-heavy commands.
       */
      useShellWrap?: boolean;
      reason?: string;
    }
  | { type: "run_script"; script: string; timeoutSec?: number; reason?: string }
  | { type: "runtime_info"; reason?: string }
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
      type: "batch_actions";
      actions: BatchableAgentAction[];
      reason?: string;
    }
  | {
      type: "send_media";
      path: string;
      mediaType?: ChannelMediaType;
      caption?: string;
      reason?: string;
    }
  | {
      type: "request_human_auth";
      capability: HumanAuthCapability;
      instruction: string;
      timeoutSec?: number;
      reason?: string;
      uiTemplate?: HumanAuthUiTemplate;
      templatePath?: string;
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
  | {
      type: "todo_write";
      op: "add" | "update" | "complete" | "delete";
      id?: string;
      text?: string;
      status?: "pending" | "in_progress" | "done";
      tags?: string[];
      reason?: string;
    }
  | {
      type: "evidence_add";
      kind: string;
      title: string;
      fields?: Record<string, unknown>;
      source?: Record<string, unknown>;
      confidence?: number;
      reason?: string;
    }
  | {
      type: "artifact_add";
      kind: string;
      value: string;
      description?: string;
      reason?: string;
    }
  | {
      type: "journal_read";
      scope: "todos" | "evidence" | "artifacts" | "all";
      limit?: number;
      reason?: string;
    }
  | {
      type: "journal_checkpoint";
      name: string;
      notes?: string;
      reason?: string;
    }
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

export type TaskExecutionSurface = "coding_first" | "phone_first" | "hybrid";

export interface TaskExecutionPlan {
  surface: TaskExecutionSurface;
  confidence: number;
  reason: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: "workspace" | "local" | "bundled";
  path: string;
}

export interface CronScheduleSpec {
  kind: "cron" | "at" | "every";
  expr?: string | null;
  at?: string | null;
  everyMs?: number | null;
  tz: string;
  summaryText: string;
}

export interface CronDeliveryTarget {
  mode: "announce";
  channel: string;
  to: string;
}

export interface ScheduleIntent {
  sourceText: string;
  normalizedTask: string;
  schedule: CronScheduleSpec;
  delivery?: CronDeliveryTarget | null;
  requiresConfirmation: boolean;
  confirmationPrompt: string;
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
