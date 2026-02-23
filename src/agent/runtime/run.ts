import type { AgentRunResult } from "../../types.js";
import type { RunTaskRequest, RuntimeRunDependencies } from "./types.js";

const AGENT_BUSY_RESULT: AgentRunResult = {
  ok: false,
  message: "Agent is busy. Please retry later.",
  sessionPath: "",
  skillPath: null,
  scriptPath: null,
};

export async function runRuntimeTask(
  deps: RuntimeRunDependencies,
  request: RunTaskRequest,
): Promise<AgentRunResult> {
  if (deps.isBusy()) {
    return { ...AGENT_BUSY_RESULT };
  }

  deps.beginRun(request.task);
  let shouldReturnHome = false;
  try {
    const outcome = await deps.executeAttempt(request);
    shouldReturnHome = outcome.shouldReturnHome;
    return outcome.result;
  } finally {
    await deps.finalizeRun(shouldReturnHome);
  }
}
