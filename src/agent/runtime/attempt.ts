import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import {
  type AssistantMessage as PiAssistantMessage,
  type Message as PiMessage,
  type TextContent as PiTextContent,
  type ImageContent as PiImageContent,
  type Model as PiModel,
  type Api as PiApi,
  type SimpleStreamOptions as PiSimpleStreamOptions,
  streamSimple,
} from "@mariozechner/pi-ai";

import type {
  AgentAction,
  CronTaskPlan,
  HumanAuthDecision,
  OpenPocketConfig,
  ScreenSnapshot,
  TaskExecutionPlan,
} from "../../types.js";
import { getModelProfile, resolveModelAuth } from "../../config/index.js";
import { formatDetailedError } from "../../utils/error-details.js";
import { sleep } from "../../utils/time.js";
import { ensureAndroidCustomToolNames } from "../android-custom-tools.js";
import { buildPiAiModel } from "../model-client.js";
import { normalizePiSessionEvent } from "../pi-session-events.js";
import { buildSystemPrompt, buildUserPrompt } from "../prompts.js";
import { AutoSkillRefiner } from "../../skills/auto-skill-refiner.js";
import type {
  PhoneAgentRunContext,
  RunTaskAttemptOutcome,
  RunTaskRequest,
  RuntimeAttemptDependencies,
} from "./types.js";

type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

interface ScreenObservationMessage {
  role: "screenObservation";
  snapshot: ScreenSnapshot;
  recentSnapshots: ScreenSnapshot[];
  stepIndex: number;
  screenshotPath: string | null;
  timestamp: number;
}

function selectObservationImage(
  snapshot: Pick<ScreenSnapshot, "somScreenshotBase64" | "screenshotBase64" | "secureSurfaceDetected">,
): { data: string; tag: "som" | "raw" } | null {
  if (snapshot.somScreenshotBase64) {
    return { data: snapshot.somScreenshotBase64, tag: "som" };
  }
  if (snapshot.secureSurfaceDetected) {
    return null;
  }
  if (!snapshot.screenshotBase64) {
    return null;
  }
  return { data: snapshot.screenshotBase64, tag: "raw" };
}

const MAX_REUSED_SESSION_MESSAGES = 64;
const RETRYABLE_MODEL_ERROR_MAX_RETRIES = 2;
const RETRYABLE_MODEL_ERROR_BASE_DELAY_MS = 1_000;

interface RuntimeModelInfo {
  provider: string;
  api: string;
  model: string;
  currentApp: string;
  stepNo: number;
}

function isOpenAiLikeBaseUrl(baseUrl: string): boolean {
  const lower = baseUrl.toLowerCase();
  return lower.includes("openai.com") || lower.includes("chatgpt.com");
}

function isCodexCliCapableModelId(modelId: string): boolean {
  const model = modelId.trim().toLowerCase();
  return model.includes("codex") || model === "gpt-5.4" || model.startsWith("gpt-5.4-");
}

function shouldShowCodexCliHint(modelId: string, baseUrl: string): boolean {
  return isOpenAiLikeBaseUrl(baseUrl) && isCodexCliCapableModelId(modelId);
}

function isOpenAiLikeRuntimeModel(modelInfo: Pick<RuntimeModelInfo, "provider" | "api" | "model">): boolean {
  const haystack = `${modelInfo.provider} ${modelInfo.api} ${modelInfo.model}`.toLowerCase();
  return haystack.includes("openai") || haystack.includes("codex") || haystack.includes("gpt-");
}

function hasRetryableServerErrorSignature(detail: string): boolean {
  const lower = detail.toLowerCase();
  if (
    lower.includes("code=server_error")
    || lower.includes("\"code\":\"server_error\"")
    || lower.includes("type=server_error")
    || lower.includes("\"type\":\"server_error\"")
  ) {
    return true;
  }
  return /\bstatus=(500|502|503|504)\b/i.test(detail)
    || /"(?:status|statuscode)"\s*:\s*(500|502|503|504)\b/i.test(detail);
}

function isRetryableUpstreamModelError(
  detail: string,
  modelInfo: Pick<RuntimeModelInfo, "provider" | "api" | "model">,
): boolean {
  return isOpenAiLikeRuntimeModel(modelInfo) && hasRetryableServerErrorSignature(detail);
}

const PHONE_ONLY_TOOL_NAMES = new Set([
  "tap",
  "tap_element",
  "swipe",
  "drag",
  "long_press_drag",
  "type_text",
  "keyevent",
  "launch_app",
  "shell",
  "batch_actions",
  "run_script",
  "send_media",
  "request_human_auth",
  "request_user_decision",
  "request_user_input",
  "wait",
]);

export function resolveRuntimeBackend(config: OpenPocketConfig): "legacy_agent_core" | "pi_session_bridge" {
  return config.agent.runtimeBackend === "pi_session_bridge"
    ? "pi_session_bridge"
    : "legacy_agent_core";
}

function loadReusedSessionMessages(sessionPath: string): AgentMessage[] {
  try {
    const manager = SessionManager.open(sessionPath);
    const context = manager.buildSessionContext();
    return context.messages
      .filter((message) => (
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult"
      ))
      .slice(-MAX_REUSED_SESSION_MESSAGES);
  } catch {
    return [];
  }
}

function buildExecutionSurfaceGuidance(plan: TaskExecutionPlan | null | undefined): string {
  if (!plan || plan.confidence < 0.55) {
    return "";
  }
  const surface = plan.surface === "coding_first"
    ? "coding/runtime tools first"
    : plan.surface === "phone_first"
      ? "phone-use tools first"
      : "hybrid probing";
  const confidence = Number.isFinite(plan.confidence) ? Math.max(0, Math.min(1, plan.confidence)) : 0.5;
  const reason = String(plan.reason || "").replace(/\s+/g, " ").trim().slice(0, 240) || "model_execution_surface";
  return [
    "",
    "## Execution Surface Arbitration (model-routed)",
    `- Preferred starting surface: ${surface}.`,
    `- Confidence: ${confidence.toFixed(2)}.`,
    `- Rationale: ${reason}.`,
    "- Start with tools from the preferred surface to gather first concrete evidence.",
    "- If two consecutive steps do not improve certainty, switch to the other surface.",
    "- Do not default to phone UI when runtime/workspace evidence is more direct.",
  ].join("\n");
}

function buildCronTaskPlanGuidance(plan: CronTaskPlan | null | undefined): string {
  if (!plan) {
    return "";
  }
  const summary = String(plan.summary || "").replace(/\s+/g, " ").trim().slice(0, 240) || "Run one focused scheduled pass.";
  const completionCriteria = String(plan.completionCriteria || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320) || "Finish after completing one focused pass or when the step budget is exhausted.";
  const stepBudget = Number.isFinite(plan.stepBudget) ? Math.max(1, Math.round(plan.stepBudget)) : 30;
  const steps = Array.isArray(plan.steps)
    ? plan.steps
      .map((step) => String(step || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 8)
    : [];
  return [
    "",
    "## Scheduled Run Plan (bounded)",
    `- Summary: ${summary}`,
    `- Step budget for this run: ${stepBudget}.`,
    `- Completion criteria: ${completionCriteria}`,
    "- This task is recurring. Complete one focused pass only; do not monitor indefinitely.",
    "- If the checklist is substantially complete before the budget is exhausted, call finish immediately.",
    "- If the step budget is exhausted, the run will be closed normally and the next scheduled trigger can continue later.",
    steps.length > 0 ? "- Planned checklist:" : "",
    ...steps.map((step, idx) => `  ${idx + 1}. ${step}`),
  ].filter(Boolean).join("\n");
}

function buildCronBudgetCompletionMessage(ctx: Pick<PhoneAgentRunContext, "stepCount" | "maxSteps" | "cronTaskPlan">): string {
  const summary = String(ctx.cronTaskPlan?.summary || "").replace(/\s+/g, " ").trim();
  const summarySuffix = summary ? ` ${summary}` : "";
  return `Completed this scheduled run window after ${ctx.stepCount}/${ctx.maxSteps} steps.${summarySuffix} Remaining work can continue on the next scheduled trigger.`;
}

function completeBoundedCronRunIfNeeded(ctx: Pick<PhoneAgentRunContext, "finishMessage" | "failMessage" | "stepCount" | "maxSteps" | "cronTaskPlan">): boolean {
  if (!ctx.cronTaskPlan) {
    return false;
  }
  if (ctx.finishMessage || ctx.failMessage) {
    return true;
  }
  ctx.finishMessage = buildCronBudgetCompletionMessage(ctx);
  return true;
}

export async function runRuntimeAttempt(
  deps: RuntimeAttemptDependencies,
  request: RunTaskRequest,
): Promise<RunTaskAttemptOutcome> {
  let shouldReturnHome = false;

  const profileKey = request.modelName ?? deps.config.defaultModel;
  const profile = getModelProfile(deps.config, profileKey);
  // eslint-disable-next-line no-console
  console.log(`[OpenPocket][agent] attempt start profile=${profileKey} model=${profile.model} baseUrl=${profile.baseUrl}`);
  const session = deps.workspace.createSession(
    request.task,
    profileKey,
    profile.model,
    { sessionKey: request.sessionKey },
  );
  const autoSkillRefiner = new AutoSkillRefiner(deps.config);
  const reusedSessionMessages = session.reused ? loadReusedSessionMessages(session.path) : [];
  let runtimeModelInfo: RuntimeModelInfo = {
    provider: "unknown",
    api: "unknown",
    model: profile.model,
    currentApp: "unknown",
    stepNo: 0,
  };
  const resolveFinalSkillPath = (skillPath: string | null, finalMessage: string): string | null => {
    if (!skillPath) {
      return null;
    }
    const refined = autoSkillRefiner.refine({
      draftSkillPath: skillPath,
      task: request.task,
      finalMessage,
    });
    if (refined.promotedPath) {
      if (refined.promotedPath !== skillPath) {
        // eslint-disable-next-line no-console
        console.log(`[OpenPocket][artifact] promoted auto skill: ${refined.promotedPath}`);
      }
      return refined.promotedPath;
    }
    if (refined.issues.length > 0) {
      const preview = refined.issues
        .slice(0, 2)
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join("; ");
      // eslint-disable-next-line no-console
      console.log(`[OpenPocket][artifact] auto skill refine failed: ${preview}`);
    }
    return skillPath;
  };

  try {
    const auth = resolveModelAuth(profile);
    if (!auth) {
      const codexHint = shouldShowCodexCliHint(profile.model, profile.baseUrl)
        ? " or login via Codex CLI (`~/.codex/auth.json`)" : "";
      const message = `Missing API key for model '${profile.model}'. Set env ${profile.apiKeyEnv} or config.models.${profileKey}.apiKey${codexHint}`;
      deps.workspace.finalizeSession(session, false, message);
      deps.workspace.appendDailyMemory(profileKey, request.task, false, message);
      return {
        result: { ok: false, message, sessionPath: session.path, skillPath: null, scriptPath: null },
        shouldReturnHome,
      };
    }

    const effectiveProfile = auth.baseUrl ? { ...profile, baseUrl: auth.baseUrl } : profile;
    const isCodexModel = profile.model.toLowerCase().includes("codex");

    const piModel = buildPiAiModel(effectiveProfile);
    const isCodexResponsesModel =
      piModel.api === "openai-codex-responses" || piModel.provider === "openai-codex";
    let finalModel: PiModel<PiApi>;
    if (isCodexResponsesModel) {
      finalModel = {
        ...piModel,
        provider: "openai-codex",
        api: "openai-codex-responses" as PiApi,
      };
    } else {
      finalModel = auth.preferredMode === "responses"
        ? { ...piModel, api: "openai-responses" as PiApi }
        : auth.preferredMode === "completions"
          ? { ...piModel, api: "openai-completions" as PiApi }
          : piModel;
      if (finalModel.api === "openai-responses" && auth.preferredMode !== "responses" && !isCodexModel) {
        finalModel = { ...finalModel, api: "openai-completions" as PiApi };
      }
    }

    const skillPromptContext = deps.skillLoader.buildPromptContextForTask(request.task);
    const workspacePromptContext = deps.buildWorkspacePromptContext();
    const effectivePromptMode = request.promptMode ?? deps.config.agent.systemPromptMode;
    const baseSystemPrompt = buildSystemPrompt(skillPromptContext.summaryText, workspacePromptContext.text, {
      mode: effectivePromptMode,
      availableToolNames: request.availableToolNames,
      activeSkillsText: skillPromptContext.activePromptText,
    });
    const systemPrompt = `${baseSystemPrompt}${buildExecutionSurfaceGuidance(request.taskExecutionPlan)}${buildCronTaskPlanGuidance(request.cronTaskPlan)}`;
    const report = deps.buildSystemPromptReport({
      source: "run",
      promptMode: effectivePromptMode,
      systemPrompt,
      skillsSummary: skillPromptContext.summaryText,
      activeSkillsPrompt: skillPromptContext.activePromptText,
      activeSkillsEntries: skillPromptContext.activeEntries.map((entry) => ({
        name: entry.skill.name,
        source: entry.skill.source,
        path: entry.skill.path,
        reason: entry.reason,
        score: entry.score,
        blockChars: entry.contentChars,
        truncated: entry.truncated,
      })),
      workspaceReport: workspacePromptContext.report,
    });
    deps.setLastSystemPromptReport(report);

    const launchableApps = (() => {
      if (typeof deps.adb.queryLaunchableApps === "function") {
        try {
          const apps = deps.adb.queryLaunchableApps(deps.config.agent.deviceId);
          if (Array.isArray(apps) && apps.length > 0) {
            return apps;
          }
        } catch {
          // Fall back to package-only metadata.
        }
      }
      return null;
    })();

    const launchablePackages = (() => {
      if (launchableApps) {
        return launchableApps.map((item) => item.packageName);
      }
      if (typeof deps.adb.queryLaunchablePackages !== "function") {
        return [];
      }
      try {
        return deps.adb.queryLaunchablePackages(deps.config.agent.deviceId);
      } catch {
        return [];
      }
    })();

    const ctx: PhoneAgentRunContext = {
      task: request.task,
      profileKey,
      profile,
      session,
      stepCount: 0,
      maxSteps: request.maxStepsOverride ?? deps.config.agent.maxSteps,
      latestSnapshot: null,
      recentSnapshotWindow: [],
      lastScreenshotPath: null,
      lastSomScreenshotPath: null,
      lastRecentScreenshotPaths: [],
      history: [],
      traces: [],
      finishMessage: null,
      failMessage: null,
      stopRequested: deps.getStopRequested,
      lastAutoPermissionAllowAtMs: 0,
      lastScreenshotStartMs: 0,
      lastScreenshotEndMs: 0,
      lastModelInferenceStartMs: 0,
      capabilityProbeApprovalByKey: new Map(),
      secureSurfaceTakeoverRequestedApps: new Set(),
      launchablePackages,
      taskExecutionPlan: request.taskExecutionPlan ?? null,
      cronTaskPlan: request.cronTaskPlan ?? null,
      runtimeModel: profile.backend === "aliyun_ui_agent_mobile" || profile.backend === "aliyun_gui_plus"
        ? {
          id: effectiveProfile.model,
          provider: profile.backend === "aliyun_gui_plus" ? "aliyun-gui-plus" : "aliyun-ui-agent",
          api: profile.backend === "aliyun_gui_plus" ? "aliyun-gui-plus" : "aliyun-ui-agent-mobile",
          baseUrl: effectiveProfile.baseUrl,
          authSource: auth.source,
        }
        : {
          id: String((finalModel as { id?: unknown }).id ?? effectiveProfile.model),
          provider: String((finalModel as { provider?: unknown }).provider ?? "unknown"),
          api: String((finalModel as { api?: unknown }).api ?? "unknown"),
          baseUrl: String((finalModel as { baseUrl?: unknown }).baseUrl ?? effectiveProfile.baseUrl),
          authSource: auth.source,
        },
      effectivePromptMode,
      systemPrompt,
      aliyunSessionId: null,
      onHumanAuth: request.onHumanAuth,
      onChannelMedia: request.onChannelMedia,
      onUserDecision: request.onUserDecision,
      onUserInput: request.onUserInput,
      onProgress: request.onProgress,
    };
    runtimeModelInfo = {
      provider: ctx.runtimeModel.provider,
      api: ctx.runtimeModel.api,
      model: ctx.runtimeModel.id,
      currentApp: "unknown",
      stepNo: 0,
    };

    const recordModelResponseError = (source: string, error: unknown): string => {
      const detail = formatDetailedError(error);
      return recordFormattedModelResponseError(source, detail);
    };

    const recordFormattedModelResponseError = (source: string, detail: string): string => {
      runtimeModelInfo = {
        ...runtimeModelInfo,
        stepNo: ctx.stepCount,
        currentApp: ctx.latestSnapshot?.currentApp ?? "unknown",
      };
      // eslint-disable-next-line no-console
      console.error(
        `[OpenPocket][model][error] source=${source} provider=${runtimeModelInfo.provider} api=${runtimeModelInfo.api} model=${runtimeModelInfo.model} step=${runtimeModelInfo.stepNo} app=${runtimeModelInfo.currentApp} detail=${detail}`,
      );
      deps.workspace.appendEvent(
        session,
        "model_response_error",
        {
          source,
          provider: runtimeModelInfo.provider,
          api: runtimeModelInfo.api,
          model: runtimeModelInfo.model,
          stepNo: runtimeModelInfo.stepNo,
          currentApp: runtimeModelInfo.currentApp,
        },
        detail,
      );
      return `Model response error: ${detail}`;
    };

    const runtimeBackend = resolveRuntimeBackend(deps.config);
    const requestedToolNames = request.availableToolNames;
    const hasPhoneOnlyTools = Array.isArray(requestedToolNames) && requestedToolNames
      .some((name) => PHONE_ONLY_TOOL_NAMES.has(String(name)));
    const usePiSessionBridge = runtimeBackend === "pi_session_bridge" && !hasPhoneOnlyTools;
    const availableToolNamesForRun = usePiSessionBridge
      ? requestedToolNames
      : runtimeBackend === "pi_session_bridge"
        ? ensureAndroidCustomToolNames(requestedToolNames)
        : requestedToolNames;
    const tools = deps.buildPhoneAgentTools(ctx, availableToolNamesForRun);
    const apiKey = auth.apiKey;
    const continuationTasks = new Set<Promise<void>>();
    let retryableModelErrorCount = 0;

    const trackContinuationTask = (task: Promise<void>): void => {
      continuationTasks.add(task);
      void task.finally(() => {
        continuationTasks.delete(task);
      });
    };

    const drainContinuationTasks = async (): Promise<void> => {
      while (continuationTasks.size > 0) {
        await Promise.allSettled([...continuationTasks]);
      }
    };

    const maybeEscalateSecureSurfaceTakeover = async (): Promise<void> => {
      if (ctx.finishMessage || ctx.failMessage) {
        return;
      }
      const snapshot = ctx.latestSnapshot;
      const uiCandidates = Array.isArray(snapshot?.uiElements) ? snapshot.uiElements : [];
      if (!snapshot || !snapshot.secureSurfaceDetected || uiCandidates.length > 0) {
        return;
      }
      const appKey = String(snapshot.currentApp || "unknown").trim().toLowerCase() || "unknown";
      if (ctx.secureSurfaceTakeoverRequestedApps.has(appKey)) {
        return;
      }
      if (!deps.config.humanAuth.enabled) {
        ctx.failMessage = `Secure surface detected in ${snapshot.currentApp} with no UI-tree candidates, but human auth is disabled.`;
        return;
      }
      if (!ctx.onHumanAuth) {
        ctx.failMessage = `Secure surface detected in ${snapshot.currentApp} with no UI-tree candidates, but no human auth handler is configured.`;
        return;
      }

      ctx.secureSurfaceTakeoverRequestedApps.add(appKey);
      const timeoutCapSec = Math.max(30, Math.round(deps.config.humanAuth.requestTimeoutSec));
      const timeoutSec = Math.min(timeoutCapSec, 240);
      const instruction = `FLAG_SECURE screen detected in ${snapshot.currentApp} and UI tree has no actionable nodes. Open Remote Takeover live stream, control the Agent Phone directly, then approve to resume automation.`;

      let decision: HumanAuthDecision;
      try {
        decision = await ctx.onHumanAuth({
          sessionId: session.id,
          sessionPath: session.path,
          task: ctx.task,
          step: ctx.stepCount + 1,
          capability: "unknown",
          instruction,
          reason: "secure_surface_no_ui_tree_takeover",
          timeoutSec,
          currentApp: snapshot.currentApp,
          screenshotPath: ctx.lastScreenshotPath,
          uiTemplate: {
            templateId: "secure-surface-takeover-v1",
            title: "Human Takeover Required: Secure Screen",
            summary: `OpenPocket detected FLAG_SECURE in ${snapshot.currentApp} and could not extract actionable UI nodes. Use the live stream to remotely control Agent Phone, then approve to continue.`,
            capabilityHint: "detected=secure_surface_no_ui_tree takeover=required",
            requireArtifactOnApprove: false,
            allowTextAttachment: false,
            allowLocationAttachment: false,
            allowPhotoAttachment: false,
            allowAudioAttachment: false,
            allowFileAttachment: false,
            approveLabel: "Takeover Complete",
            rejectLabel: "Stop Task",
            notePlaceholder: "Optional context after takeover",
          },
        });
      } catch (error) {
        decision = {
          requestId: "secure-surface-takeover-error",
          approved: false,
          status: "rejected",
          message: `Human auth error: ${(error as Error).message}`,
          decidedAt: new Date().toISOString(),
          artifactPath: null,
        };
      }

      ctx.history.push(
        `step ${ctx.stepCount + 1}: secure_takeover decision=${decision.status} app=${snapshot.currentApp}`,
      );

      if (!decision.approved) {
        ctx.failMessage = decision.message || "Human takeover was not approved for secure surface.";
        return;
      }

      await sleep(350);
      const refreshed = await deps.adb.captureScreenSnapshot(deps.config.agent.deviceId, profile.model);
      refreshed.installedApps = launchableApps ?? refreshed.installedApps;
      refreshed.installedPackages = launchablePackages;
      ctx.latestSnapshot = refreshed;
    };

    const thinkingMap: Record<string, Exclude<ThinkingLevel, "off">> = {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    };
    const thinkingLevel: ThinkingLevel = profile.reasoningEffort && profile.reasoningEffort in thinkingMap
      ? thinkingMap[profile.reasoningEffort] : "off";

    const captureAliyunSnapshot = async (): Promise<ScreenSnapshot | null> => {
      if (ctx.finishMessage || ctx.failMessage) {
        return null;
      }
      if (ctx.stopRequested()) {
        ctx.failMessage = "Task stopped by user.";
        return null;
      }
      if (ctx.stepCount >= ctx.maxSteps) {
        if (!completeBoundedCronRunIfNeeded(ctx)) {
          ctx.failMessage = `Max steps reached (${ctx.maxSteps})`;
        }
        return null;
      }

      ctx.lastScreenshotStartMs = Date.now();
      const snapshot = await deps.adb.captureScreenSnapshot(deps.config.agent.deviceId, profile.model);
      snapshot.installedApps = launchableApps ?? snapshot.installedApps;
      snapshot.installedPackages = launchablePackages;
      ctx.latestSnapshot = snapshot;
      ctx.lastScreenshotEndMs = Date.now();
      shouldReturnHome = true;

      if (deps.config.screenshots.saveStepScreenshots) {
        try {
          ctx.lastScreenshotPath = deps.screenshotStore.save(
            Buffer.from(snapshot.screenshotBase64, "base64"),
            { sessionId: session.id, step: ctx.stepCount + 1, currentApp: snapshot.currentApp },
          );
        } catch {
          ctx.lastScreenshotPath = null;
        }
        try {
          ctx.lastSomScreenshotPath = snapshot.somScreenshotBase64
            ? deps.screenshotStore.save(
                Buffer.from(snapshot.somScreenshotBase64, "base64"),
                { sessionId: session.id, step: ctx.stepCount + 1, currentApp: `${snapshot.currentApp}-som` },
              )
            : null;
        } catch {
          ctx.lastSomScreenshotPath = null;
        }
        const recentForSave = ctx.recentSnapshotWindow.slice(-2);
        const recentPaths: string[] = [];
        for (const recent of recentForSave) {
          try {
            const selected = selectObservationImage(recent);
            if (!selected) {
              continue;
            }
            const saved = deps.screenshotStore.save(
              Buffer.from(selected.data, "base64"),
              {
                sessionId: session.id,
                step: ctx.stepCount + 1,
                currentApp: `${recent.currentApp}${selected.tag === "som" ? "-recent-som" : "-recent"}`,
              },
            );
            recentPaths.push(saved);
          } catch {
            // Best-effort recent screenshot persistence.
          }
        }
        ctx.lastRecentScreenshotPaths = recentPaths;
      }

      if (
        deps.isPermissionDialogApp(snapshot.currentApp) &&
        Date.now() - ctx.lastAutoPermissionAllowAtMs >= 1_200
      ) {
        const auto = await deps.autoApprovePermissionDialog(snapshot.currentApp);
        if (auto?.action?.type === "tap") {
          ctx.lastAutoPermissionAllowAtMs = Date.now();
          await sleep(300);
          const refreshed = await deps.adb.captureScreenSnapshot(deps.config.agent.deviceId, profile.model);
          refreshed.installedApps = launchableApps ?? refreshed.installedApps;
          refreshed.installedPackages = launchablePackages;
          ctx.latestSnapshot = refreshed;
        }
      }

      await maybeEscalateSecureSurfaceTakeover();
      if (ctx.failMessage || !ctx.latestSnapshot) {
        return null;
      }

      deps.saveModelInputArtifacts({
        sessionId: session.id,
        step: ctx.stepCount + 1,
        task: ctx.task,
        profileModel: profile.model,
        promptMode: ctx.effectivePromptMode,
        systemPrompt: ctx.systemPrompt,
        userPrompt: buildUserPrompt(
          ctx.task,
          ctx.stepCount + 1,
          ctx.latestSnapshot,
          ctx.history,
          ctx.recentSnapshotWindow.slice(-2),
        ),
        snapshot: ctx.latestSnapshot,
        history: ctx.history,
      });

      ctx.recentSnapshotWindow.push(ctx.latestSnapshot);
      if (ctx.recentSnapshotWindow.length > 3) {
        ctx.recentSnapshotWindow = ctx.recentSnapshotWindow.slice(-3);
      }
      return ctx.latestSnapshot;
    };

    const buildAliyunAddInfo = (snapshot: ScreenSnapshot): string => {
      const lines = [
        `Current app: ${snapshot.currentApp}`,
        `Step: ${ctx.stepCount + 1}/${ctx.maxSteps}`,
      ];
      const recentHistory = ctx.history.slice(-4);
      if (recentHistory.length > 0) {
        lines.push("Recent history:");
        for (const item of recentHistory) {
          lines.push(`- ${item}`);
        }
      }
      return lines.join("\n");
    };

    const executeAliyunAction = async (action: AgentAction): Promise<string> => {
      if (action.type === "finish") {
        ctx.finishMessage = action.message;
        return `FINISH: ${action.message}`;
      }
      if (action.type === "wait") {
        const durationMs = Math.max(100, Number(action.durationMs ?? 1000));
        await sleep(durationMs);
        return `Waited ${durationMs}ms`;
      }
      shouldReturnHome = true;
      return await deps.adb.executeAction(action, deps.config.agent.deviceId);
    };

    if (profile.backend === "aliyun_ui_agent_mobile") {
      const screenshotStack = deps.localHumanAuthStackFactory(deps.config);
      const aliyunClient = deps.aliyunUiAgentClientFactory({
        apiKey,
        baseUrl: effectiveProfile.baseUrl,
        modelName: effectiveProfile.model,
        thoughtLanguage: "english",
        sessionId: ctx.aliyunSessionId,
      });

      try {
        await screenshotStack.start();

        while (!ctx.finishMessage && !ctx.failMessage) {
          const snapshot = await captureAliyunSnapshot();
          if (!snapshot) {
            break;
          }

          ctx.lastModelInferenceStartMs = Date.now();
          const signedScreenshot = await screenshotStack.createSignedScreenshotUrl({ ttlSec: 60 });
          const stepResult = await aliyunClient.nextStep({
            task: ctx.task,
            screenshotUrl: signedScreenshot.url,
            addInfo: buildAliyunAddInfo(snapshot),
            viewportWidth: snapshot.width,
            viewportHeight: snapshot.height,
          });

          ctx.aliyunSessionId = stepResult.sessionId;
          aliyunClient.setSessionId(stepResult.sessionId);

          const stepNo = ctx.stepCount + 1;
          ctx.stepCount = stepNo;
          const executionResult = await executeAliyunAction(stepResult.output.action);

          deps.workspace.appendStep(
            session,
            stepNo,
            stepResult.output.thought,
            JSON.stringify(stepResult.output.action),
            executionResult,
          );

          ctx.history.push(
            `step ${stepNo}: action=${stepResult.output.action.type} result=${executionResult.replace(/\s+/g, " ").trim()}`,
          );

          if (ctx.onProgress) {
            await ctx.onProgress({
              step: stepNo,
              maxSteps: ctx.maxSteps,
              actionType: stepResult.output.action.type,
              thought: stepResult.output.thought,
              message: executionResult,
              currentApp: ctx.latestSnapshot?.currentApp ?? "unknown",
              screenshotPath: ctx.lastScreenshotPath,
            });
          }

          if (!ctx.finishMessage && !ctx.failMessage && ctx.stepCount >= ctx.maxSteps) {
            if (!completeBoundedCronRunIfNeeded(ctx)) {
              ctx.failMessage = `Max steps reached (${ctx.maxSteps})`;
            }
          }
        }
      } catch (error) {
        ctx.failMessage = `Aliyun UI Agent error: ${(error as Error).message}`;
      } finally {
        await screenshotStack.stop().catch(() => {});
      }

      if (!ctx.finishMessage && !ctx.failMessage && ctx.stopRequested()) {
        ctx.failMessage = "Task stopped by user.";
      }

      if (ctx.finishMessage) {
        deps.workspace.finalizeSession(session, true, ctx.finishMessage);
        deps.workspace.appendDailyMemory(profileKey, request.task, true, ctx.finishMessage);
        const artifacts = deps.autoArtifactBuilder.build({
          task: request.task,
          sessionPath: session.path,
          ok: true,
          finalMessage: ctx.finishMessage,
          traces: ctx.traces,
        });
        if (artifacts.skillPath) {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][artifact] auto skill: ${artifacts.skillPath}`);
        }
        if (artifacts.scriptPath) {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][artifact] auto script: ${artifacts.scriptPath}`);
        }
        const finalSkillPath = resolveFinalSkillPath(artifacts.skillPath, ctx.finishMessage);
        return {
          result: {
            ok: true,
            message: ctx.finishMessage,
            sessionPath: session.path,
            skillPath: finalSkillPath,
            scriptPath: artifacts.scriptPath,
          },
          shouldReturnHome,
        };
      }

      const failMsg = ctx.failMessage || "Aliyun UI Agent stopped without finishing.";
      deps.workspace.finalizeSession(session, false, failMsg);
      deps.workspace.appendDailyMemory(profileKey, request.task, false, failMsg);
      return {
        result: { ok: false, message: failMsg, sessionPath: session.path, skillPath: null, scriptPath: null },
        shouldReturnHome,
      };
    }

    if (profile.backend === "aliyun_gui_plus") {
      const guiPlusClient = deps.aliyunGuiPlusClientFactory({
        apiKey,
        baseUrl: effectiveProfile.baseUrl,
        modelName: effectiveProfile.model,
        thoughtLanguage: "english",
      });

      const buildGuiPlusAddInfo = (snapshot: ScreenSnapshot): string => {
        const lines = [
          `Current app: ${snapshot.currentApp}`,
          `Step: ${ctx.stepCount + 1}/${ctx.maxSteps}`,
        ];
        const recentHistory = ctx.history.slice(-4);
        if (recentHistory.length > 0) {
          lines.push("Recent history:");
          for (const item of recentHistory) {
            lines.push(`- ${item}`);
          }
        }
        return lines.join("\n");
      };

      const executeGuiPlusAction = async (action: AgentAction): Promise<string> => {
        if (action.type === "finish") {
          ctx.finishMessage = action.message;
          return `FINISH: ${action.message}`;
        }
        if (action.type === "wait") {
          const durationMs = Math.max(100, Number(action.durationMs ?? 1000));
          await sleep(durationMs);
          return `Waited ${durationMs}ms`;
        }
        shouldReturnHome = true;
        return await deps.adb.executeAction(action, deps.config.agent.deviceId);
      };

      try {
        while (!ctx.finishMessage && !ctx.failMessage) {
          if (ctx.stopRequested()) {
            break;
          }

          const snapshot = await captureAliyunSnapshot();
          if (!snapshot) {
            break;
          }

          ctx.lastModelInferenceStartMs = Date.now();
          const stepResult = await guiPlusClient.nextStep({
            task: ctx.task,
            screenshotBase64: snapshot.screenshotBase64,
            addInfo: buildGuiPlusAddInfo(snapshot),
            viewportWidth: snapshot.width,
            viewportHeight: snapshot.height,
          });

          const stepNo = ctx.stepCount + 1;
          ctx.stepCount = stepNo;
          const executionResult = await executeGuiPlusAction(stepResult.output.action);

          deps.workspace.appendStep(
            session,
            stepNo,
            stepResult.output.thought,
            JSON.stringify(stepResult.output.action),
            executionResult,
          );

          ctx.history.push(
            `step ${stepNo}: action=${stepResult.output.action.type} result=${executionResult.replace(/\s+/g, " ").trim()}`,
          );

          if (ctx.onProgress) {
            await ctx.onProgress({
              step: stepNo,
              maxSteps: ctx.maxSteps,
              actionType: stepResult.output.action.type,
              thought: stepResult.output.thought,
              message: executionResult,
              currentApp: ctx.latestSnapshot?.currentApp ?? "unknown",
              screenshotPath: ctx.lastScreenshotPath,
            });
          }

          if (!ctx.finishMessage && !ctx.failMessage && ctx.stepCount >= ctx.maxSteps) {
            if (!completeBoundedCronRunIfNeeded(ctx)) {
              ctx.failMessage = `Max steps reached (${ctx.maxSteps})`;
            }
          }
        }
      } catch (error) {
        ctx.failMessage = `GUI-Plus error: ${(error as Error).message}`;
      }

      if (!ctx.finishMessage && !ctx.failMessage && ctx.stopRequested()) {
        ctx.failMessage = "Task stopped by user.";
      }

      if (ctx.finishMessage) {
        deps.workspace.finalizeSession(session, true, ctx.finishMessage);
        deps.workspace.appendDailyMemory(profileKey, request.task, true, ctx.finishMessage);
        const artifacts = deps.autoArtifactBuilder.build({
          task: request.task,
          sessionPath: session.path,
          ok: true,
          finalMessage: ctx.finishMessage,
          traces: ctx.traces,
        });
        if (artifacts.skillPath) {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][artifact] auto skill: ${artifacts.skillPath}`);
        }
        if (artifacts.scriptPath) {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][artifact] auto script: ${artifacts.scriptPath}`);
        }
        const finalSkillPath = resolveFinalSkillPath(artifacts.skillPath, ctx.finishMessage);
        return {
          result: {
            ok: true,
            message: ctx.finishMessage,
            sessionPath: session.path,
            skillPath: finalSkillPath,
            scriptPath: artifacts.scriptPath,
          },
          shouldReturnHome,
        };
      }

      const failMsg = ctx.failMessage || "GUI-Plus stopped without finishing.";
      deps.workspace.finalizeSession(session, false, failMsg);
      deps.workspace.appendDailyMemory(profileKey, request.task, false, failMsg);
      return {
        result: { ok: false, message: failMsg, sessionPath: session.path, skillPath: null, scriptPath: null },
        shouldReturnHome,
      };
    }

    if (usePiSessionBridge) {
      const appendSessionEvent = (
        eventType: string,
        details?: Record<string, unknown>,
        text?: string,
      ) => {
        try {
          deps.workspace.appendEvent(session, eventType, details, text);
        } catch {
          // Best-effort telemetry write.
        }
      };

      const persistNormalizedEvent = (event: AgentSessionEvent) => {
        const normalized = normalizePiSessionEvent(event);
        if (!normalized) {
          return;
        }
        const baseDetails = {
          stepNo: ctx.stepCount,
          currentApp: ctx.latestSnapshot?.currentApp ?? "unknown",
        };
        if (normalized.type === "tool_execution_start") {
          shouldReturnHome = true;
          appendSessionEvent(
            "tool_execution_start",
            {
              ...baseDetails,
              toolName: normalized.toolName,
              ...(normalized.toolCallId ? { toolCallId: normalized.toolCallId } : {}),
              ...(normalized.args !== undefined ? { args: normalized.args } : {}),
            },
            `tool_execution_start ${normalized.toolName}`,
          );
          return;
        }
        if (normalized.type === "tool_execution_update") {
          const text = normalized.text || "";
          appendSessionEvent(
            "tool_execution_update",
            {
              ...baseDetails,
              toolName: normalized.toolName,
              ...(normalized.toolCallId ? { toolCallId: normalized.toolCallId } : {}),
              ...(normalized.args !== undefined ? { args: normalized.args } : {}),
              text,
            },
            text.trim() ? `tool_execution_update ${normalized.toolName}\n${text}` : `tool_execution_update ${normalized.toolName}`,
          );
          return;
        }
        if (normalized.type === "tool_execution_end") {
          appendSessionEvent(
            "tool_execution_end",
            {
              ...baseDetails,
              toolName: normalized.toolName,
              isError: normalized.isError,
              ...(normalized.toolCallId ? { toolCallId: normalized.toolCallId } : {}),
              ...(normalized.result !== undefined ? { result: normalized.result } : {}),
            },
            `tool_execution_end ${normalized.toolName} error=${String(normalized.isError)}`,
          );
          return;
        }
        if (
          normalized.type === "agent_start"
          || normalized.type === "agent_end"
          || normalized.type === "turn_start"
          || normalized.type === "turn_end"
        ) {
          appendSessionEvent(normalized.type, baseDetails, normalized.type);
        }
      };

      const authStorage = AuthStorage.inMemory();
      authStorage.setRuntimeApiKey(finalModel.provider, apiKey);
      const modelRegistry = new ModelRegistry(authStorage);
      const resourceLoader = new DefaultResourceLoader({
        cwd: deps.config.workspaceDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt,
      });
      await resourceLoader.reload();

      const bridge = await deps.piSessionBridgeFactory({
        createOptions: {
          cwd: deps.config.workspaceDir,
          model: finalModel,
          thinkingLevel: thinkingLevel as any,
          tools,
          resourceLoader,
          authStorage,
          modelRegistry,
          sessionManager: SessionManager.open(session.path),
        },
      });

      const bridgeState: { lastAssistantMessage: PiAssistantMessage | null } = {
        lastAssistantMessage: null,
      };
      const readLastBridgeAssistantMessage = (): PiAssistantMessage | null => bridgeState.lastAssistantMessage;
      let bridgeRetryableModelErrorCount = 0;
      let abortRequested = false;
      let stopPollTimer: NodeJS.Timeout | null = null;
      const unsubscribe = bridge.subscribeRaw((event) => {
        persistNormalizedEvent(event as AgentSessionEvent);
        if (event.type === "turn_end") {
          const maybeAssistant = event.message as PiAssistantMessage;
          if (maybeAssistant?.role === "assistant") {
            bridgeState.lastAssistantMessage = maybeAssistant;
          }
        }
      });

      try {
        // eslint-disable-next-line no-console
        console.log(`[OpenPocket][pi-session-bridge] starting task: ${request.task}`);
        stopPollTimer = setInterval(() => {
          if (abortRequested || !ctx.stopRequested()) {
            return;
          }
          abortRequested = true;
          ctx.failMessage = "Task stopped by user.";
          void bridge.abort().catch(() => {});
        }, 250);
        let promptText: string | null = `Task: ${request.task}`;
        while (promptText && !ctx.finishMessage && !ctx.failMessage && !ctx.stopRequested()) {
          bridgeState.lastAssistantMessage = null;
          await bridge.prompt(promptText);
          if (ctx.finishMessage || ctx.failMessage || ctx.stopRequested()) {
            break;
          }
          const lastAssistantMessage = readLastBridgeAssistantMessage();
          if (!lastAssistantMessage) {
            break;
          }
          if (lastAssistantMessage.stopReason === "error") {
            const errorPayload = {
              message: lastAssistantMessage.errorMessage || lastAssistantMessage.stopReason,
              errorMessage: lastAssistantMessage.errorMessage,
              stopReason: lastAssistantMessage.stopReason,
            };
            const detail = formatDetailedError(errorPayload);
            if (
              bridgeRetryableModelErrorCount < RETRYABLE_MODEL_ERROR_MAX_RETRIES
              && isRetryableUpstreamModelError(detail, runtimeModelInfo)
            ) {
              bridgeRetryableModelErrorCount += 1;
              const retryAttempt = bridgeRetryableModelErrorCount;
              const delayMs = RETRYABLE_MODEL_ERROR_BASE_DELAY_MS * (2 ** (retryAttempt - 1));
              appendSessionEvent(
                "model_response_retry_scheduled",
                {
                  source: "pi_session_bridge",
                  provider: runtimeModelInfo.provider,
                  api: runtimeModelInfo.api,
                  model: runtimeModelInfo.model,
                  stepNo: ctx.stepCount,
                  currentApp: ctx.latestSnapshot?.currentApp ?? "unknown",
                  retryAttempt,
                  maxRetries: RETRYABLE_MODEL_ERROR_MAX_RETRIES,
                  delayMs,
                },
                `model_response_retry_scheduled attempt=${retryAttempt}/${RETRYABLE_MODEL_ERROR_MAX_RETRIES} delay_ms=${delayMs}`,
              );
              await sleep(delayMs);
              if (ctx.finishMessage || ctx.failMessage || ctx.stopRequested()) {
                break;
              }
              if (ctx.stepCount >= ctx.maxSteps) {
                if (!completeBoundedCronRunIfNeeded(ctx)) {
                  ctx.failMessage = `Max steps reached (${ctx.maxSteps})`;
                }
                break;
              }
              promptText = `Step ${ctx.stepCount + 1}: continue executing the task.`;
              continue;
            }
            ctx.failMessage = recordFormattedModelResponseError("pi_session_bridge", detail);
            break;
          }
          if (lastAssistantMessage.stopReason === "aborted") {
            ctx.failMessage = recordModelResponseError("pi_session_bridge", {
              message: lastAssistantMessage.errorMessage || lastAssistantMessage.stopReason,
              errorMessage: lastAssistantMessage.errorMessage,
              stopReason: lastAssistantMessage.stopReason,
            });
            break;
          }
          bridgeRetryableModelErrorCount = 0;
          break;
        }
      } finally {
        if (stopPollTimer) {
          clearInterval(stopPollTimer);
        }
        unsubscribe();
        bridge.dispose();
      }

      if (!ctx.finishMessage && !ctx.failMessage && bridgeState.lastAssistantMessage) {
        const lastAssistantMessage = bridgeState.lastAssistantMessage;
        if (lastAssistantMessage.stopReason === "error" || lastAssistantMessage.stopReason === "aborted") {
          ctx.failMessage = recordModelResponseError("pi_session_bridge", {
            message: lastAssistantMessage.errorMessage || lastAssistantMessage.stopReason,
            errorMessage: lastAssistantMessage.errorMessage,
            stopReason: lastAssistantMessage.stopReason,
          });
        } else {
          const parsed = deps.parseTextualToolFallback(lastAssistantMessage, ctx.task);
          if (parsed) {
            const fallbackTool = tools.find((item) => item.name === parsed.toolName);
            if (!fallbackTool) {
              ctx.failMessage = `Model textual fallback resolved unknown tool '${parsed.toolName}'.`;
            } else {
              try {
                await fallbackTool.execute(`bridge-text-fallback-${Date.now()}`, parsed.params);
              } catch (error) {
                ctx.failMessage = `Textual tool fallback execution error: ${(error as Error).message}`;
              }
            }
          } else {
            ctx.failMessage = "Model response did not include a tool call.";
          }
        }
      }

      if (!ctx.finishMessage && !ctx.failMessage && ctx.stopRequested()) {
        ctx.failMessage = "Task stopped by user.";
      }

      if (ctx.finishMessage) {
        deps.workspace.finalizeSession(session, true, ctx.finishMessage);
        deps.workspace.appendDailyMemory(profileKey, request.task, true, ctx.finishMessage);
        const artifacts = deps.autoArtifactBuilder.build({
          task: request.task,
          sessionPath: session.path,
          ok: true,
          finalMessage: ctx.finishMessage,
          traces: ctx.traces,
        });
        if (artifacts.skillPath) {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][artifact] auto skill: ${artifacts.skillPath}`);
        }
        if (artifacts.scriptPath) {
          // eslint-disable-next-line no-console
          console.log(`[OpenPocket][artifact] auto script: ${artifacts.scriptPath}`);
        }
        const finalSkillPath = resolveFinalSkillPath(artifacts.skillPath, ctx.finishMessage);
        return {
          result: {
            ok: true,
            message: ctx.finishMessage,
            sessionPath: session.path,
            skillPath: finalSkillPath,
            scriptPath: artifacts.scriptPath,
          },
          shouldReturnHome,
        };
      }

      const failMsg = ctx.failMessage || "Agent stopped without finishing.";
      deps.workspace.finalizeSession(session, false, failMsg);
      deps.workspace.appendDailyMemory(profileKey, request.task, false, failMsg);
      return {
        result: { ok: false, message: failMsg, sessionPath: session.path, skillPath: null, scriptPath: null },
        shouldReturnHome,
      };
    }

    const agent = deps.agentFactory({
      initialState: {
        systemPrompt,
        model: finalModel,
        tools,
        thinkingLevel: thinkingLevel as any,
        messages: reusedSessionMessages,
      },
      sessionId: session.id,
      streamFn: (model, context, options) => {
        const supportsToolChoice = model.api === "openai-completions";
        const opts = supportsToolChoice
          ? { ...options, toolChoice: "required" } as PiSimpleStreamOptions & { toolChoice: "required" }
          : options;
        return streamSimple(model, context, opts as PiSimpleStreamOptions);
      },
      getApiKey: async () => apiKey,
      convertToLlm: (messages: AgentMessage[]): PiMessage[] => {
        return messages.flatMap((message): PiMessage[] => {
          if (message.role === "screenObservation") {
            const observation = message as ScreenObservationMessage;
            const snapshot = observation.snapshot;
            const observationText = buildUserPrompt(
              ctx.task,
              observation.stepIndex,
              snapshot,
              ctx.history,
              observation.recentSnapshots,
            );
            const content: Array<PiTextContent | PiImageContent> = [
              { type: "text", text: observationText },
            ];

            // Send recent frames when visual payload is available for each frame.
            for (const recent of observation.recentSnapshots) {
              const selected = selectObservationImage(recent);
              if (selected) {
                content.push({ type: "image", data: selected.data, mimeType: "image/png" });
              }
            }
            const currentSelected = selectObservationImage(snapshot);
            if (currentSelected) {
              content.push({ type: "image", data: currentSelected.data, mimeType: "image/png" });
            }
            return [{ role: "user", content, timestamp: message.timestamp }];
          }
          if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
            return [message as PiMessage];
          }
          return [];
        });
      },
      transformContext: async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
        if (ctx.finishMessage || ctx.failMessage) {
          return messages;
        }
        if (ctx.stopRequested()) {
          ctx.failMessage = "Task stopped by user.";
          return messages;
        }
        if (ctx.stepCount >= ctx.maxSteps) {
          if (!completeBoundedCronRunIfNeeded(ctx)) {
            ctx.failMessage = `Max steps reached (${ctx.maxSteps})`;
          }
          return messages;
        }

        ctx.lastScreenshotStartMs = Date.now();
        const snapshot = await deps.adb.captureScreenSnapshot(deps.config.agent.deviceId, profile.model);
        snapshot.installedApps = launchableApps ?? snapshot.installedApps;
        snapshot.installedPackages = launchablePackages;
        ctx.latestSnapshot = snapshot;
        ctx.lastScreenshotEndMs = Date.now();
        shouldReturnHome = true;

        if (deps.config.screenshots.saveStepScreenshots) {
          try {
            ctx.lastScreenshotPath = deps.screenshotStore.save(
              Buffer.from(snapshot.screenshotBase64, "base64"),
              { sessionId: session.id, step: ctx.stepCount + 1, currentApp: snapshot.currentApp },
            );
          } catch {
            ctx.lastScreenshotPath = null;
          }
          // Save SoM overlay screenshot
          try {
            ctx.lastSomScreenshotPath = snapshot.somScreenshotBase64
              ? deps.screenshotStore.save(
                  Buffer.from(snapshot.somScreenshotBase64, "base64"),
                  { sessionId: session.id, step: ctx.stepCount + 1, currentApp: `${snapshot.currentApp}-som` },
                )
              : null;
          } catch {
            ctx.lastSomScreenshotPath = null;
          }
          // Save recent snapshot screenshots (prior frames sent to model).
          // The model receives SoM first, otherwise raw if not secure-blackout.
          const recentForSave = ctx.recentSnapshotWindow.slice(-2);
          const recentPaths: string[] = [];
          for (const recent of recentForSave) {
            try {
              const selected = selectObservationImage(recent);
              if (!selected) {
                continue;
              }
              const buf = Buffer.from(selected.data, "base64");
              const suffix = selected.tag === "som" ? "-recent-som" : "-recent";
              const p = deps.screenshotStore.save(
                buf,
                { sessionId: session.id, step: ctx.stepCount + 1, currentApp: `${recent.currentApp}${suffix}` },
              );
              recentPaths.push(p);
            } catch { /* best-effort */ }
          }
          ctx.lastRecentScreenshotPaths = recentPaths;
        }

        if (
          deps.isPermissionDialogApp(snapshot.currentApp) &&
          Date.now() - ctx.lastAutoPermissionAllowAtMs >= 1_200
        ) {
          const auto = await deps.autoApprovePermissionDialog(snapshot.currentApp);
          if (auto?.action?.type === "tap") {
            ctx.lastAutoPermissionAllowAtMs = Date.now();
            await sleep(300);
            const refreshed = await deps.adb.captureScreenSnapshot(deps.config.agent.deviceId, profile.model);
            refreshed.installedApps = launchableApps ?? refreshed.installedApps;
            refreshed.installedPackages = launchablePackages;
            ctx.latestSnapshot = refreshed;
          }
        }

        await maybeEscalateSecureSurfaceTakeover();
        if (ctx.failMessage) {
          return messages;
        }

        const latestSnapshot = ctx.latestSnapshot;
        if (!latestSnapshot) {
          return messages;
        }

        const stepForArtifact = ctx.stepCount + 1;
        const observationTextForArtifact = buildUserPrompt(
          ctx.task,
          stepForArtifact,
          latestSnapshot,
          ctx.history,
        );
        deps.saveModelInputArtifacts({
          sessionId: session.id,
          step: stepForArtifact,
          task: ctx.task,
          profileModel: profile.model,
          promptMode: ctx.effectivePromptMode,
          systemPrompt: ctx.systemPrompt,
          userPrompt: observationTextForArtifact,
          snapshot: latestSnapshot,
          history: ctx.history,
        });

        const recentSnapshots = ctx.recentSnapshotWindow.slice(-2);
        ctx.recentSnapshotWindow.push(latestSnapshot);
        if (ctx.recentSnapshotWindow.length > 3) {
          ctx.recentSnapshotWindow = ctx.recentSnapshotWindow.slice(-3);
        }

        const filtered = messages.filter((message) => message.role !== "screenObservation");
        const observation: ScreenObservationMessage = {
          role: "screenObservation",
          snapshot: latestSnapshot,
          recentSnapshots,
          stepIndex: ctx.stepCount + 1,
          screenshotPath: ctx.lastScreenshotPath,
          timestamp: Date.now(),
        };
        ctx.lastModelInferenceStartMs = Date.now();
        return [...filtered, observation];
      },
      followUpMode: "one-at-a-time",
    });

    const checkContinuation = () => {
      if (ctx.finishMessage || ctx.failMessage || ctx.stopRequested()) {
        if (typeof agent.abort === "function") {
          agent.abort();
        }
        return;
      }
      if (ctx.stepCount >= ctx.maxSteps) {
        if (!completeBoundedCronRunIfNeeded(ctx)) {
          ctx.failMessage = `Max steps reached (${ctx.maxSteps})`;
        }
        if (typeof agent.abort === "function") {
          agent.abort();
        }
        return;
      }
      agent.followUp({
        role: "user",
        content: [{ type: "text", text: `Step ${ctx.stepCount + 1}: continue executing the task.` }],
        timestamp: Date.now(),
      });
    };

    const appendSessionEvent = (
      eventType: string,
      details?: Record<string, unknown>,
      text?: string,
    ) => {
      try {
        deps.workspace.appendEvent(session, eventType, details, text);
      } catch {
        // Best-effort telemetry write.
      }
    };

    const persistNormalizedEvent = (event: AgentEvent) => {
      const normalized = normalizePiSessionEvent(event as unknown as AgentSessionEvent);
      if (!normalized) {
        return;
      }
      const baseDetails = {
        stepNo: ctx.stepCount,
        currentApp: ctx.latestSnapshot?.currentApp ?? "unknown",
      };
      if (normalized.type === "tool_execution_start") {
        appendSessionEvent(
          "tool_execution_start",
          {
            ...baseDetails,
            toolName: normalized.toolName,
            ...(normalized.toolCallId ? { toolCallId: normalized.toolCallId } : {}),
            ...(normalized.args !== undefined ? { args: normalized.args } : {}),
          },
          `tool_execution_start ${normalized.toolName}`,
        );
        return;
      }
      if (normalized.type === "tool_execution_update") {
        const text = normalized.text || "";
        appendSessionEvent(
          "tool_execution_update",
          {
            ...baseDetails,
            toolName: normalized.toolName,
            ...(normalized.toolCallId ? { toolCallId: normalized.toolCallId } : {}),
            ...(normalized.args !== undefined ? { args: normalized.args } : {}),
            text,
          },
          text.trim() ? `tool_execution_update ${normalized.toolName}\n${text}` : `tool_execution_update ${normalized.toolName}`,
        );
        return;
      }
      if (normalized.type === "tool_execution_end") {
        appendSessionEvent(
          "tool_execution_end",
          {
            ...baseDetails,
            toolName: normalized.toolName,
            isError: normalized.isError,
            ...(normalized.toolCallId ? { toolCallId: normalized.toolCallId } : {}),
            ...(normalized.result !== undefined ? { result: normalized.result } : {}),
          },
          `tool_execution_end ${normalized.toolName} error=${String(normalized.isError)}`,
        );
        return;
      }
      if (
        normalized.type === "agent_start"
        || normalized.type === "agent_end"
        || normalized.type === "turn_start"
        || normalized.type === "turn_end"
      ) {
        appendSessionEvent(normalized.type, baseDetails, normalized.type);
      }
    };

    agent.subscribe((event: AgentEvent) => {
      persistNormalizedEvent(event);
      if (event.type !== "turn_end") {
        return;
      }
      const assistantMessage = event.message as PiAssistantMessage;
      if (assistantMessage.role !== "assistant") {
        return;
      }
      if (assistantMessage.stopReason === "error") {
        const errorPayload = {
          message: assistantMessage.errorMessage || assistantMessage.stopReason,
          errorMessage: assistantMessage.errorMessage,
          stopReason: assistantMessage.stopReason,
        };
        const detail = formatDetailedError(errorPayload);
        if (
          retryableModelErrorCount < RETRYABLE_MODEL_ERROR_MAX_RETRIES
          && isRetryableUpstreamModelError(detail, runtimeModelInfo)
        ) {
          retryableModelErrorCount += 1;
          const retryAttempt = retryableModelErrorCount;
          const delayMs = RETRYABLE_MODEL_ERROR_BASE_DELAY_MS * (2 ** (retryAttempt - 1));
          appendSessionEvent(
            "model_response_retry_scheduled",
            {
              source: "legacy_agent_core",
              provider: runtimeModelInfo.provider,
              api: runtimeModelInfo.api,
              model: runtimeModelInfo.model,
              stepNo: ctx.stepCount,
              currentApp: ctx.latestSnapshot?.currentApp ?? "unknown",
              retryAttempt,
              maxRetries: RETRYABLE_MODEL_ERROR_MAX_RETRIES,
              delayMs,
            },
            `model_response_retry_scheduled attempt=${retryAttempt}/${RETRYABLE_MODEL_ERROR_MAX_RETRIES} delay_ms=${delayMs}`,
          );
          trackContinuationTask((async () => {
            try {
              await sleep(delayMs);
              if (ctx.finishMessage || ctx.failMessage || ctx.stopRequested()) {
                return;
              }
              checkContinuation();
              if (!ctx.finishMessage && !ctx.failMessage && !ctx.stopRequested()) {
                await agent.waitForIdle();
              }
            } catch (error) {
              if (!ctx.finishMessage && !ctx.failMessage) {
                ctx.failMessage = recordModelResponseError("legacy_agent_core_retry", error);
              }
            }
          })());
          return;
        }
        ctx.failMessage = recordFormattedModelResponseError("legacy_agent_core", detail);
        return;
      }
      if (assistantMessage.stopReason === "aborted") {
        ctx.failMessage = recordModelResponseError("legacy_agent_core", {
          message: assistantMessage.errorMessage || assistantMessage.stopReason,
          errorMessage: assistantMessage.errorMessage,
          stopReason: assistantMessage.stopReason,
        });
        return;
      }
      retryableModelErrorCount = 0;
      const hasToolCall = assistantMessage.content.some((item) => item.type === "toolCall");
      if (!hasToolCall && !ctx.finishMessage && !ctx.failMessage) {
        const fallbackTask = (async () => {
          try {
            const parsed = deps.parseTextualToolFallback(assistantMessage, ctx.task);
            if (!parsed) {
              ctx.failMessage = "Model response did not include a tool call.";
              return;
            }
            const fallbackTool = tools.find((item) => item.name === parsed.toolName);
            if (!fallbackTool) {
              ctx.failMessage = `Model textual fallback resolved unknown tool '${parsed.toolName}'.`;
              return;
            }
            await fallbackTool.execute(`text-fallback-${Date.now()}`, parsed.params);
            checkContinuation();
            if (!ctx.finishMessage && !ctx.failMessage && !ctx.stopRequested()) {
              await agent.waitForIdle();
            }
          } catch (error) {
            if (!ctx.finishMessage && !ctx.failMessage) {
              ctx.failMessage = `Textual tool fallback execution error: ${(error as Error).message}`;
            }
          }
        })();
        trackContinuationTask(fallbackTask);
        return;
      }
      checkContinuation();
    });

    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][agent-core] starting task: ${request.task}`);
    await agent.prompt(`Task: ${request.task}`);
    await agent.waitForIdle();
    await drainContinuationTasks();
    const agentStateError = (agent as { state?: { error?: string } }).state?.error;
    if (!ctx.finishMessage && !ctx.failMessage && typeof agentStateError === "string" && agentStateError.trim()) {
      ctx.failMessage = recordModelResponseError("legacy_agent_core_state", agentStateError);
    }

    if (ctx.finishMessage) {
      deps.workspace.finalizeSession(session, true, ctx.finishMessage);
      deps.workspace.appendDailyMemory(profileKey, request.task, true, ctx.finishMessage);
      const artifacts = deps.autoArtifactBuilder.build({
        task: request.task,
        sessionPath: session.path,
        ok: true,
        finalMessage: ctx.finishMessage,
        traces: ctx.traces,
      });
      if (artifacts.skillPath) {
        // eslint-disable-next-line no-console
        console.log(`[OpenPocket][artifact] auto skill: ${artifacts.skillPath}`);
      }
      if (artifacts.scriptPath) {
        // eslint-disable-next-line no-console
        console.log(`[OpenPocket][artifact] auto script: ${artifacts.scriptPath}`);
      }
      const finalSkillPath = resolveFinalSkillPath(artifacts.skillPath, ctx.finishMessage);
      return {
        result: {
          ok: true,
          message: ctx.finishMessage,
          sessionPath: session.path,
          skillPath: finalSkillPath,
          scriptPath: artifacts.scriptPath,
        },
        shouldReturnHome,
      };
    }

    const failMsg = ctx.failMessage || "Agent stopped without finishing.";
    deps.workspace.finalizeSession(session, false, failMsg);
    deps.workspace.appendDailyMemory(profileKey, request.task, false, failMsg);
    return {
      result: { ok: false, message: failMsg, sessionPath: session.path, skillPath: null, scriptPath: null },
      shouldReturnHome,
    };
  } catch (error) {
    const detail = formatDetailedError(error);
    // eslint-disable-next-line no-console
    console.error(
      `[OpenPocket][agent][error] provider=${runtimeModelInfo.provider} api=${runtimeModelInfo.api} model=${runtimeModelInfo.model} step=${runtimeModelInfo.stepNo} app=${runtimeModelInfo.currentApp} detail=${detail}`,
    );
    deps.workspace.appendEvent(
      session,
      "agent_execution_error",
      {
        provider: runtimeModelInfo.provider,
        api: runtimeModelInfo.api,
        model: runtimeModelInfo.model,
        stepNo: runtimeModelInfo.stepNo,
        currentApp: runtimeModelInfo.currentApp,
      },
      detail,
    );
    const message = `Agent execution failed: ${detail}`;
    deps.workspace.finalizeSession(session, false, message);
    deps.workspace.appendDailyMemory(profileKey, request.task, false, message);
    return {
      result: { ok: false, message, sessionPath: session.path, skillPath: null, scriptPath: null },
      shouldReturnHome,
    };
  }
}
