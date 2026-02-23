import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
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

import type { ScreenSnapshot } from "../../types.js";
import { getModelProfile, resolveModelAuth } from "../../config/index.js";
import { sleep } from "../../utils/time.js";
import { buildPiAiModel } from "../model-client.js";
import { buildSystemPrompt, buildUserPrompt } from "../prompts.js";
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

export async function runRuntimeAttempt(
  deps: RuntimeAttemptDependencies,
  request: RunTaskRequest,
): Promise<RunTaskAttemptOutcome> {
  let shouldReturnHome = false;

  const profileKey = request.modelName ?? deps.config.defaultModel;
  const profile = getModelProfile(deps.config, profileKey);
  const session = deps.workspace.createSession(request.task, profileKey, profile.model);

  try {
    const auth = resolveModelAuth(profile);
    if (!auth) {
      const codexHint = profile.model.toLowerCase().includes("codex")
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
      if (finalModel.api === "openai-responses" && auth.preferredMode !== "responses") {
        finalModel = { ...finalModel, api: "openai-completions" as PiApi };
      }
    }

    const skillsSummary = deps.skillLoader.summaryText();
    const workspacePromptContext = deps.buildWorkspacePromptContext();
    const effectivePromptMode = request.promptMode ?? deps.config.agent.systemPromptMode;
    const systemPrompt = buildSystemPrompt(skillsSummary, workspacePromptContext.text, {
      mode: effectivePromptMode,
      availableToolNames: request.availableToolNames,
    });
    const report = deps.buildSystemPromptReport({
      source: "run",
      promptMode: effectivePromptMode,
      systemPrompt,
      skillsSummary,
      workspaceReport: workspacePromptContext.report,
    });
    deps.setLastSystemPromptReport(report);

    const launchablePackages = typeof deps.adb.queryLaunchablePackages === "function"
      ? deps.adb.queryLaunchablePackages(deps.config.agent.deviceId) : [];

    const ctx: PhoneAgentRunContext = {
      task: request.task,
      profileKey,
      profile,
      session,
      stepCount: 0,
      maxSteps: deps.config.agent.maxSteps,
      latestSnapshot: null,
      recentSnapshotWindow: [],
      lastScreenshotPath: null,
      history: [],
      traces: [],
      finishMessage: null,
      failMessage: null,
      stopRequested: deps.getStopRequested,
      lastAutoPermissionAllowAtMs: 0,
      launchablePackages,
      effectivePromptMode,
      systemPrompt,
      onHumanAuth: request.onHumanAuth,
      onUserDecision: request.onUserDecision,
      onProgress: request.onProgress,
    };

    const tools = deps.buildPhoneAgentTools(ctx, request.availableToolNames);
    const apiKey = auth.apiKey;
    const turnFallbackTasks: Promise<void>[] = [];

    const thinkingMap: Record<string, Exclude<ThinkingLevel, "off">> = {
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    };
    const thinkingLevel: ThinkingLevel = profile.reasoningEffort && profile.reasoningEffort in thinkingMap
      ? thinkingMap[profile.reasoningEffort] : "off";

    const agent = deps.agentFactory({
      initialState: {
        systemPrompt,
        model: finalModel,
        tools,
        thinkingLevel: thinkingLevel as any,
      },
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
            for (const recent of observation.recentSnapshots) {
              if (recent.somScreenshotBase64) {
                content.push({ type: "image", data: recent.somScreenshotBase64, mimeType: "image/png" });
              } else {
                content.push({ type: "image", data: recent.screenshotBase64, mimeType: "image/png" });
              }
            }
            if (snapshot.somScreenshotBase64) {
              content.push({ type: "image", data: snapshot.somScreenshotBase64, mimeType: "image/png" });
            }
            content.push({ type: "image", data: snapshot.screenshotBase64, mimeType: "image/png" });
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
          ctx.failMessage = `Max steps reached (${ctx.maxSteps})`;
          return messages;
        }

        const snapshot = await deps.adb.captureScreenSnapshot(deps.config.agent.deviceId, profile.model);
        snapshot.installedPackages = launchablePackages;
        ctx.latestSnapshot = snapshot;
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
            refreshed.installedPackages = launchablePackages;
            ctx.latestSnapshot = refreshed;
          }
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
        ctx.failMessage = `Max steps reached (${ctx.maxSteps})`;
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

    agent.subscribe((event: AgentEvent) => {
      if (event.type !== "turn_end") {
        return;
      }
      const assistantMessage = event.message as PiAssistantMessage;
      if (assistantMessage.role !== "assistant") {
        return;
      }
      if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
        const detail = assistantMessage.errorMessage || assistantMessage.stopReason;
        ctx.failMessage = `Model response error: ${detail}`;
        return;
      }
      const hasToolCall = assistantMessage.content.some((item) => item.type === "toolCall");
      if (!hasToolCall && !ctx.finishMessage && !ctx.failMessage) {
        const fallbackTask = (async () => {
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
          try {
            await fallbackTool.execute(`text-fallback-${Date.now()}`, parsed.params);
          } catch (error) {
            ctx.failMessage = `Textual tool fallback execution error: ${(error as Error).message}`;
            return;
          }
          checkContinuation();
        })();
        turnFallbackTasks.push(fallbackTask);
        return;
      }
      checkContinuation();
    });

    // eslint-disable-next-line no-console
    console.log(`[OpenPocket][agent-core] starting task: ${request.task}`);
    await agent.prompt(`Task: ${request.task}`);
    await agent.waitForIdle();
    if (turnFallbackTasks.length > 0) {
      await Promise.allSettled(turnFallbackTasks);
    }
    const agentStateError = (agent as { state?: { error?: string } }).state?.error;
    if (!ctx.finishMessage && !ctx.failMessage && typeof agentStateError === "string" && agentStateError.trim()) {
      ctx.failMessage = `Model response error: ${agentStateError}`;
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
      return {
        result: {
          ok: true,
          message: ctx.finishMessage,
          sessionPath: session.path,
          skillPath: artifacts.skillPath,
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
    const message = `Agent execution failed: ${(error as Error).message}`;
    deps.workspace.finalizeSession(session, false, message);
    deps.workspace.appendDailyMemory(profileKey, request.task, false, message);
    return {
      result: { ok: false, message, sessionPath: session.path, skillPath: null, scriptPath: null },
      shouldReturnHome,
    };
  }
}
