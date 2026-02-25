import type { AgentTool, Agent, AgentOptions } from "@mariozechner/pi-agent-core";
import type { AssistantMessage as PiAssistantMessage } from "@mariozechner/pi-ai";

import type {
  AgentAction,
  AgentProgressUpdate,
  AgentRunResult,
  HumanAuthDecision,
  HumanAuthRequest,
  ModelProfile,
  OpenPocketConfig,
  ScreenSnapshot,
  UserDecisionRequest,
  UserDecisionResponse,
  UserInputRequest,
  UserInputResponse,
} from "../../types.js";
import type { SessionHandle, WorkspaceStore } from "../../memory/workspace.js";
import type { AdbRuntime } from "../../device/adb-runtime.js";
import type { ScreenshotStore } from "../../memory/screenshot-store.js";
import { type AutoArtifactBuilder, type StepTrace } from "../../skills/auto-artifact-builder.js";
import type { SkillLoader } from "../../skills/skill-loader.js";
import type { SystemPromptMode } from "../prompts.js";

export interface RunTaskRequest {
  task: string;
  modelName?: string;
  sessionKey?: string;
  onProgress?: (update: AgentProgressUpdate) => Promise<void> | void;
  onHumanAuth?: (request: HumanAuthRequest) => Promise<HumanAuthDecision> | HumanAuthDecision;
  promptMode?: SystemPromptMode;
  onUserDecision?: (request: UserDecisionRequest) => Promise<UserDecisionResponse> | UserDecisionResponse;
  onUserInput?: (request: UserInputRequest) => Promise<UserInputResponse> | UserInputResponse;
  availableToolNames?: string[];
}

export interface RunTaskAttemptOutcome {
  result: AgentRunResult;
  shouldReturnHome: boolean;
}

export interface RuntimeRunDependencies {
  isBusy: () => boolean;
  beginRun: (task: string) => void;
  executeAttempt: (request: RunTaskRequest) => Promise<RunTaskAttemptOutcome>;
  finalizeRun: (shouldReturnHome: boolean) => Promise<void>;
}

export interface BuildSystemPromptReportParams {
  source: "estimate" | "run";
  promptMode: SystemPromptMode;
  systemPrompt: string;
  skillsSummary: string;
  activeSkillsPrompt?: string;
  activeSkillsEntries?: Array<{
    name: string;
    source: "workspace" | "local" | "bundled";
    path: string;
    reason: string;
    score: number;
    blockChars: number;
    truncated: boolean;
  }>;
  workspaceReport: unknown;
}

export interface RuntimeModelInputArtifactsParams {
  sessionId: string;
  step: number;
  task: string;
  profileModel: string;
  promptMode: SystemPromptMode;
  systemPrompt: string;
  userPrompt: string;
  snapshot: {
    currentApp: string;
    width: number;
    height: number;
    scaledWidth: number;
    scaledHeight: number;
    capturedAt: string;
    screenshotBase64: string;
    somScreenshotBase64: string | null;
    uiElements: unknown[];
  };
  history: string[];
}

export type ParsedTextualToolFallback = {
  toolName: string;
  params: Record<string, unknown>;
};

export type DelegationApplyLike = {
  action?: AgentAction | null;
};

export interface RuntimeAttemptDependencies {
  config: OpenPocketConfig;
  workspace: WorkspaceStore;
  adb: AdbRuntime;
  skillLoader: SkillLoader;
  autoArtifactBuilder: AutoArtifactBuilder;
  screenshotStore: ScreenshotStore;
  agentFactory: AgentFactory;
  getStopRequested: () => boolean;
  buildWorkspacePromptContext: () => { text: string; report: unknown };
  buildSystemPromptReport: (params: BuildSystemPromptReportParams) => unknown;
  setLastSystemPromptReport: (report: unknown) => void;
  buildPhoneAgentTools: (ctx: PhoneAgentRunContext, availableToolNames?: string[]) => AgentTool<any>[];
  parseTextualToolFallback: (message: PiAssistantMessage, task?: string) => ParsedTextualToolFallback | null;
  isPermissionDialogApp: (currentApp: string) => boolean;
  autoApprovePermissionDialog: (currentApp: string) => Promise<DelegationApplyLike | null>;
  saveModelInputArtifacts: (params: RuntimeModelInputArtifactsParams) => void;
}

/** Mutable state shared across tool execute closures during a single runTask invocation. */
export interface PhoneAgentRunContext {
  task: string;
  profileKey: string;
  profile: ModelProfile;
  session: SessionHandle;
  stepCount: number;
  maxSteps: number;
  latestSnapshot: ScreenSnapshot | null;
  /** Rolling window of recent snapshots for multi-frame visual context. */
  recentSnapshotWindow: ScreenSnapshot[];
  lastScreenshotPath: string | null;
  history: string[];
  traces: StepTrace[];
  finishMessage: string | null;
  failMessage: string | null;
  stopRequested: () => boolean;
  lastAutoPermissionAllowAtMs: number;
  launchablePackages: string[];
  effectivePromptMode: SystemPromptMode;
  systemPrompt: string;
  onHumanAuth?: (request: HumanAuthRequest) => Promise<HumanAuthDecision> | HumanAuthDecision;
  onUserDecision?: (request: UserDecisionRequest) => Promise<UserDecisionResponse> | UserDecisionResponse;
  onUserInput?: (request: UserInputRequest) => Promise<UserInputResponse> | UserInputResponse;
  onProgress?: (update: AgentProgressUpdate) => Promise<void> | void;
}

export type AgentLike = Pick<Agent, "followUp" | "subscribe" | "prompt" | "waitForIdle"> & {
  abort?: () => void;
};
export type AgentFactory = (options: AgentOptions) => AgentLike;
