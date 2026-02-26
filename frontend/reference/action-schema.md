# Action and Output Schema

OpenPocket action schema is a tagged union used by the task loop.
The model returns one tool call per step, and runtime normalizes it to `AgentAction`.

## Model Step Output

```ts
interface ModelStepOutput {
  thought: string;
  action: AgentAction;
  raw: string;
}
```

## AgentAction Types

```ts
type AgentAction =
  | { type: "tap"; x: number; y: number; reason?: string }
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
      capability:
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
      instruction: string;
      timeoutSec?: number;
      reason?: string;
      uiTemplate?: {
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
        middleHtml?: string;
        middleCss?: string;
        middleScript?: string;
        approveScript?: string;
        approveLabel?: string;
        rejectLabel?: string;
        noteLabel?: string;
        notePlaceholder?: string;
        fields?: Array<{
          id: string;
          label: string;
          type:
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
          placeholder?: string;
          required?: boolean;
          helperText?: string;
          options?: Array<{ label: string; value: string }>;
          autocomplete?: string;
          artifactKey?: string;
        }>;
        style?: {
          brandColor?: string;
          backgroundCss?: string;
          fontFamily?: string;
        };
      };
    }
  | { type: "wait"; durationMs?: number; reason?: string }
  | { type: "finish"; message: string };
```

## Tool Name Mapping

Tool calls use function names from `src/agent/tools.ts`.
One canonical mapping exists:

- `type_text` (tool name) -> `type` (`AgentAction.type`)

All other tool names map to the same action name.

## Normalization Defaults

When fields are missing/invalid, runtime normalizes as follows:

- `tap`: `x=0`, `y=0`
- `swipe`: coords default `0`, `durationMs=300`
- `type`: `text=""`
- `keyevent`: `keycode="KEYCODE_ENTER"`
- `launch_app`: `packageName=""`
- `shell`: `command=""`
- `run_script`: `script=""`, `timeoutSec=60`
- `read`: `from=1`, `lines=200`
- `write`: `content=""`, `append=false`
- `edit`: `find=""`, `replace=""`, `replaceAll=false`
- `apply_patch`: `input=""`
- `exec`: `yieldMs=0`, `background=false`, `timeoutSec=1800`
- `process`: invalid action -> `action="list"`, `offset=0`, `limit=200`, `timeoutMs=0`
- `memory_search`: `query=""`, `maxResults=6`, `minScore=0.2`
- `memory_get`: `from=1`, `lines=120`
- `request_human_auth`: `capability="unknown"`, `instruction="Human authorization is required to continue."`, `timeoutSec=300`
- `wait`: `durationMs=1000`
- `finish`: `message="Task finished."`
- unknown type -> `wait` (`durationMs=1000`)

## Execution Semantics

### ADB-backed actions

- `tap`: `adb shell input tap <x> <y>`
- `swipe`: `adb shell input swipe <x1> <y1> <x2> <y2> <durationMs>`
- `type`: tries `adb shell input text`; for non-ASCII or failure, falls back to clipboard + paste
- `keyevent`: `adb shell input keyevent <keycode>`
- `launch_app`: `adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1`
- `shell`: executes command tokens after `adb shell`
- `wait`: async sleep

### Script executor action

- `run_script`: executes in controlled sandbox (`ScriptExecutor`) with allowlist, deny patterns, timeout, and output caps

### Coding executor actions

- `read`, `write`, `edit`, `apply_patch`, `exec`, `process` are handled by `CodingExecutor`
- workspace path boundary is enforced when `codingTools.workspaceOnly=true`
- `exec` supports foreground, background sessions, and `yieldMs` early return
- `process` manages background sessions (`list|poll|log|write|kill`)

### Memory executor actions

- `memory_search`: searches only `MEMORY.md` and `memory/*.md`
- `memory_get`: reads only `MEMORY.md` and `memory/*.md`

### Human authorization action

- `request_human_auth`: pauses task and waits for `HumanAuthBridge` decision
- approved artifacts can be auto-applied:
  - text artifact -> typed into focused field
  - geo artifact -> `adb emu geo fix <lon> <lat>`
  - image artifact -> pushed to `/sdcard/Download/...`

### Terminal action

- `finish`: marks successful task completion and finalizes session

## Current Screen Snapshot Schema

```ts
interface ScreenSnapshot {
  deviceId: string;
  currentApp: string;
  width: number;
  height: number;
  screenshotBase64: string;
  capturedAt: string;
  scaleX: number;
  scaleY: number;
  scaledWidth: number;
  scaledHeight: number;
}
```
