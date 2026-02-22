import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { HumanAuthCapability, OpenPocketConfig } from "../types.js";
import { EmulatorManager } from "../device/emulator-manager.js";
import { ensureDir } from "../utils/paths.js";

const PACKAGE_NAME = "ai.openpocket.permissionlab";
const MAIN_ACTIVITY = `${PACKAGE_NAME}.MainActivity`;
const SCENARIO_FILTER_EXTRA = "openpocket.permissionlab.case";

const REQUESTED_PERMISSIONS = [
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.READ_CONTACTS",
  "android.permission.READ_SMS",
  "android.permission.READ_CALENDAR",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_EXTERNAL_STORAGE",
] as const;

export interface PermissionLabScenario {
  id: string;
  title: string;
  buttonLabel: string;
  capability: HumanAuthCapability;
  summary: string;
}

const DEFAULT_PERMISSION_LAB_SCENARIO_ID = "camera";

const PERMISSION_LAB_SCENARIOS: PermissionLabScenario[] = [
  {
    id: "camera",
    title: "Camera Permission",
    buttonLabel: "Request Camera Permission",
    capability: "camera",
    summary: "Trigger Android runtime camera permission dialog.",
  },
  {
    id: "microphone",
    title: "Microphone Permission",
    buttonLabel: "Request Microphone Permission",
    capability: "permission",
    summary: "Trigger Android runtime microphone permission dialog.",
  },
  {
    id: "location",
    title: "Location Permission",
    buttonLabel: "Request Location Permission",
    capability: "location",
    summary: "Trigger Android runtime location permission dialog.",
  },
  {
    id: "contacts",
    title: "Contacts Permission",
    buttonLabel: "Request Contacts Permission",
    capability: "contacts",
    summary: "Trigger Android runtime contacts permission dialog.",
  },
  {
    id: "sms",
    title: "SMS Permission",
    buttonLabel: "Request SMS Permission",
    capability: "sms",
    summary: "Trigger Android runtime SMS permission dialog.",
  },
  {
    id: "calendar",
    title: "Calendar Permission",
    buttonLabel: "Request Calendar Permission",
    capability: "calendar",
    summary: "Trigger Android runtime calendar permission dialog.",
  },
  {
    id: "photos",
    title: "Photos Permission",
    buttonLabel: "Request Photos Permission",
    capability: "files",
    summary: "Trigger Android runtime photos/media permission dialog.",
  },
  {
    id: "notification",
    title: "Notification Permission",
    buttonLabel: "Request Notification Permission",
    capability: "notification",
    summary: "Trigger Android 13+ notification runtime permission dialog.",
  },
  {
    id: "2fa",
    title: "2FA Human Auth Drill",
    buttonLabel: "Trigger Human Auth Drill (2FA style)",
    capability: "2fa",
    summary: "No system dialog; force request_human_auth(2fa) after tapping drill button.",
  },
];

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
  error: string | null;
};

export function isAdbInstallUpdateIncompatible(detail: string): boolean {
  return /INSTALL_FAILED_UPDATE_INCOMPATIBLE/i.test(detail);
}

export interface PermissionLabDeployOptions {
  deviceId?: string;
  launch?: boolean;
  clean?: boolean;
}

export interface PermissionLabDeployResult {
  apkPath: string;
  buildDir: string;
  packageName: string;
  mainActivity: string;
  deviceId: string;
  installOutput: string;
  launchOutput: string | null;
  sdkRoot: string;
  buildToolsVersion: string;
  platformVersion: string;
}

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function requireCommandOk(
  command: string,
  args: string[],
  label: string,
  env?: NodeJS.ProcessEnv,
): string {
  const out = runCommand(command, args, env);
  if (out.status !== 0 || out.error) {
    const detail = [out.error, out.stderr.trim(), out.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`${label} failed.\n${detail}`.trim());
  }
  return out.stdout;
}

function commandFailureDetail(out: CommandResult): string {
  return [out.error, out.stderr.trim(), out.stdout.trim()].filter(Boolean).join("\n");
}

function parseVersionParts(value: string): number[] {
  return value
    .split(/[.-]/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function compareVersionDesc(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) {
      return vb - va;
    }
  }
  return b.localeCompare(a);
}

function detectSdkRoot(config: OpenPocketConfig): string {
  const candidates = [
    config.emulator.androidSdkRoot,
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(process.env.HOME || "", "Library", "Android", "sdk"),
    path.join(process.env.HOME || "", "Android", "Sdk"),
  ]
    .map((item) => (item || "").trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "platform-tools", "adb"))) {
      return candidate;
    }
  }

  throw new Error(
    "Android SDK root not found. Set config.emulator.androidSdkRoot or ANDROID_SDK_ROOT.",
  );
}

function pickBuildToolsDir(sdkRoot: string): { dir: string; version: string } {
  const buildToolsRoot = path.join(sdkRoot, "build-tools");
  if (!fs.existsSync(buildToolsRoot)) {
    throw new Error(`Android build-tools not found: ${buildToolsRoot}`);
  }

  const versions = fs
    .readdirSync(buildToolsRoot)
    .filter((name) => fs.statSync(path.join(buildToolsRoot, name)).isDirectory())
    .sort(compareVersionDesc);

  for (const version of versions) {
    const dir = path.join(buildToolsRoot, version);
    const required = ["aapt2", "d8", "zipalign", "apksigner"].map((bin) => path.join(dir, bin));
    if (required.every((bin) => fs.existsSync(bin))) {
      return { dir, version };
    }
  }

  throw new Error("No usable Android build-tools found (need aapt2, d8, zipalign, apksigner).");
}

function pickPlatformAndroidJar(sdkRoot: string): { androidJar: string; version: string } {
  const platformsRoot = path.join(sdkRoot, "platforms");
  if (!fs.existsSync(platformsRoot)) {
    throw new Error(`Android platforms not found: ${platformsRoot}`);
  }

  const versions = fs
    .readdirSync(platformsRoot)
    .filter((name) => name.startsWith("android-"))
    .sort(compareVersionDesc);

  for (const version of versions) {
    const androidJar = path.join(platformsRoot, version, "android.jar");
    if (fs.existsSync(androidJar)) {
      return { androidJar, version };
    }
  }

  throw new Error("No Android platform android.jar found under SDK platforms directory.");
}

function collectFilesBySuffix(rootDir: string, suffix: string): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const stack = [rootDir];
  const out: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && fullPath.endsWith(suffix)) {
        out.push(fullPath);
      }
    }
  }

  return out.sort((a, b) => a.localeCompare(b));
}

function resolveKeytool(javaHomeOverride?: string): string {
  const javaHome = (javaHomeOverride || process.env.JAVA_HOME || "").trim();
  if (javaHome) {
    const keytool = path.join(javaHome, "bin", "keytool");
    if (fs.existsSync(keytool)) {
      return keytool;
    }
  }

  const fromPath = runCommand("which", ["keytool"]);
  if (fromPath.status === 0 && fromPath.stdout.trim()) {
    return fromPath.stdout.trim().split("\n")[0];
  }

  throw new Error("keytool not found. Install a Java JDK (17+) and ensure keytool is in PATH.");
}

function parseJavaMajor(raw: string): number | null {
  const quoted = raw.match(/version\s+"([^"]+)"/i)?.[1]?.trim();
  if (quoted) {
    const parts = quoted.split(/[._-]/).filter(Boolean);
    if (parts[0] === "1" && parts[1]) {
      const major = Number(parts[1]);
      return Number.isFinite(major) ? major : null;
    }
    const major = Number(parts[0]);
    return Number.isFinite(major) ? major : null;
  }
  const openJdk = raw.match(/openjdk\s+(\d+)/i)?.[1];
  if (openJdk) {
    const major = Number(openJdk);
    return Number.isFinite(major) ? major : null;
  }
  return null;
}

function detectJavaHome17Plus(): string | null {
  const candidates = [
    process.env.JAVA_HOME || "",
    "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
    "/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  if (process.platform === "darwin") {
    const preferred17 = runCommand("/usr/libexec/java_home", ["-v", "17"]);
    if (preferred17.status === 0 && preferred17.stdout.trim()) {
      candidates.unshift(preferred17.stdout.trim());
    }
    const preferred = runCommand("/usr/libexec/java_home", []);
    if (preferred.status === 0 && preferred.stdout.trim()) {
      candidates.push(preferred.stdout.trim());
    }
  }

  const seen = new Set<string>();
  let bestHome: string | null = null;
  let bestMajor = 0;

  for (const candidate of candidates) {
    const home = path.resolve(candidate);
    if (seen.has(home)) {
      continue;
    }
    seen.add(home);

    const javaBin = path.join(home, "bin", "java");
    if (!fs.existsSync(javaBin)) {
      continue;
    }
    const info = runCommand(javaBin, ["-version"], process.env);
    const output = `${info.stdout}\\n${info.stderr}`.trim();
    const major = parseJavaMajor(output);
    if (!major || major < 17) {
      continue;
    }
    if (major > bestMajor) {
      bestMajor = major;
      bestHome = home;
    }
  }

  return bestHome;
}

function writePermissionLabSource(projectDir: string): void {
  const srcDir = path.join(projectDir, "src", "ai", "openpocket", "permissionlab");
  const resValuesDir = path.join(projectDir, "res", "values");
  ensureDir(srcDir);
  ensureDir(resValuesDir);

  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${PACKAGE_NAME}">

    <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="34" />

    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.READ_CONTACTS" />
    <uses-permission android:name="android.permission.READ_SMS" />
    <uses-permission android:name="android.permission.READ_CALENDAR" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

    <application
        android:label="@string/app_name"
        android:icon="@android:drawable/sym_def_app_icon"
        android:allowBackup="false">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

  const mainActivity = `package ai.openpocket.permissionlab;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.SparseArray;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public class MainActivity extends Activity {
  private final SparseArray<String> requestLabels = new SparseArray<>();
  private int requestCodeSeed = 100;
  private TextView logView;
  private String scenarioCase;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    scenarioCase = normalizeScenarioCase(
      getIntent() != null ? getIntent().getStringExtra("${SCENARIO_FILTER_EXTRA}") : null
    );
    setContentView(createLayout());
    appendLog("PermissionLab ready.");
    if (scenarioCase != null) {
      appendLog("Scenario filter active: " + scenarioCase);
    }
    appendLog("Tip for agent: if blocked by permission/2FA, call request_human_auth.");
  }

  private ScrollView createLayout() {
    ScrollView root = new ScrollView(this);
    LinearLayout body = new LinearLayout(this);
    body.setOrientation(LinearLayout.VERTICAL);
    body.setPadding(32, 32, 32, 32);

    TextView title = new TextView(this);
    title.setText("OpenPocket PermissionLab");
    title.setTextSize(24);
    body.addView(title, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    TextView subtitle = new TextView(this);
    if (scenarioCase == null) {
      subtitle.setText("Use buttons below to trigger runtime permission prompts and auth-blocking scenarios.");
    } else {
      subtitle.setText("Scenario mode: " + scenarioCase + ". Tap the visible test button exactly once.");
    }
    subtitle.setTextSize(14);
    subtitle.setPadding(0, 16, 0, 16);
    body.addView(subtitle);

    addPermissionButton(body, "Request Camera Permission", Manifest.permission.CAMERA, "camera", "camera");
    addPermissionButton(body, "Request Microphone Permission", Manifest.permission.RECORD_AUDIO, "microphone", "microphone");
    addPermissionButton(body, "Request Location Permission", Manifest.permission.ACCESS_FINE_LOCATION, "location", "location");
    addPermissionButton(body, "Request Contacts Permission", Manifest.permission.READ_CONTACTS, "contacts", "contacts");
    addPermissionButton(body, "Request SMS Permission", Manifest.permission.READ_SMS, "sms", "sms");
    addPermissionButton(body, "Request Calendar Permission", Manifest.permission.READ_CALENDAR, "calendar", "calendar");

    if (showScenario("photos")) {
      Button photosButton = createButton("Request Photos Permission");
      photosButton.setOnClickListener(new View.OnClickListener() {
        @Override
        public void onClick(View v) {
          if (Build.VERSION.SDK_INT >= 33) {
            requestPermission(Manifest.permission.READ_MEDIA_IMAGES, "photos");
          } else {
            requestPermission(Manifest.permission.READ_EXTERNAL_STORAGE, "photos");
          }
        }
      });
      body.addView(photosButton);
    }

    if (showScenario("notification")) {
      Button notificationButton = createButton("Request Notification Permission");
      notificationButton.setOnClickListener(new View.OnClickListener() {
        @Override
        public void onClick(View v) {
          if (Build.VERSION.SDK_INT >= 33) {
            requestPermission(Manifest.permission.POST_NOTIFICATIONS, "notification");
          } else {
            appendLog("Notification runtime permission is only required on Android 13+.");
          }
        }
      });
      body.addView(notificationButton);
    }

    if (showScenario("2fa")) {
      Button authDrill = createButton("Trigger Human Auth Drill (2FA style)");
      authDrill.setOnClickListener(new View.OnClickListener() {
        @Override
        public void onClick(View v) {
          appendLog("2FA drill: ask OpenPocket agent to call request_human_auth with capability=2fa.");
        }
      });
      body.addView(authDrill);
    }

    if (scenarioCase == null) {
      Button settings = createButton("Open App Settings");
      settings.setOnClickListener(new View.OnClickListener() {
        @Override
        public void onClick(View v) {
          Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
          intent.setData(Uri.parse("package:" + getPackageName()));
          startActivity(intent);
        }
      });
      body.addView(settings);
    }

    TextView logTitle = new TextView(this);
    logTitle.setText("Event Log");
    logTitle.setTextSize(18);
    logTitle.setPadding(0, 24, 0, 12);
    body.addView(logTitle);

    logView = new TextView(this);
    logView.setTextIsSelectable(true);
    logView.setTextSize(13);
    logView.setPadding(18, 18, 18, 18);
    logView.setBackgroundColor(0xFFEFF3F8);
    logView.setGravity(Gravity.START);
    body.addView(logView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

    root.addView(body, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    return root;
  }

  private String normalizeScenarioCase(String raw) {
    if (raw == null) {
      return null;
    }
    String normalized = raw.trim().toLowerCase();
    if (normalized.length() == 0) {
      return null;
    }
    if (
      normalized.equals("camera")
      || normalized.equals("microphone")
      || normalized.equals("location")
      || normalized.equals("contacts")
      || normalized.equals("sms")
      || normalized.equals("calendar")
      || normalized.equals("photos")
      || normalized.equals("notification")
      || normalized.equals("2fa")
    ) {
      return normalized;
    }
    return null;
  }

  private boolean showScenario(String scenarioId) {
    return scenarioCase == null || scenarioCase.equals(scenarioId);
  }

  private void addPermissionButton(
    LinearLayout body,
    String label,
    String permission,
    String capabilityHint,
    String scenarioId
  ) {
    if (!showScenario(scenarioId)) {
      return;
    }
    Button button = createButton(label);
    button.setOnClickListener(new View.OnClickListener() {
      @Override
      public void onClick(View v) {
        requestPermission(permission, capabilityHint);
      }
    });
    body.addView(button);
  }

  private Button createButton(String label) {
    Button button = new Button(this);
    button.setText(label);
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.WRAP_CONTENT
    );
    params.setMargins(0, 0, 0, 14);
    button.setLayoutParams(params);
    return button;
  }

  private void requestPermission(String permission, String capabilityHint) {
    if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
      appendLog("Already granted: " + permission + " (" + capabilityHint + ")");
      return;
    }

    int requestCode = requestCodeSeed++;
    requestLabels.put(requestCode, capabilityHint + ":" + permission);
    appendLog("Requesting permission: " + permission + " (capability=" + capabilityHint + ")");
    requestPermissions(new String[] { permission }, requestCode);
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    String label = requestLabels.get(requestCode, "unknown");
    String permission = permissions != null && permissions.length > 0 ? permissions[0] : "unknown";
    boolean granted = grantResults != null && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
    appendLog("Permission result: " + permission + " => " + (granted ? "GRANTED" : "DENIED") + " [" + label + "]");
    if (!granted) {
      appendLog("If this blocks your flow, ask agent to trigger request_human_auth.");
    }
  }

  private void appendLog(String line) {
    if (logView == null) {
      return;
    }
    String previous = String.valueOf(logView.getText());
    if (previous.length() > 8000) {
      previous = previous.substring(previous.length() - 5000);
    }
    logView.setText(previous + "\\n" + line);
  }
}
`;

  const stringsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="app_name">OpenPocket PermissionLab</string>
</resources>
`;

  fs.writeFileSync(path.join(projectDir, "AndroidManifest.xml"), manifest, "utf-8");
  fs.writeFileSync(path.join(srcDir, "MainActivity.java"), mainActivity, "utf-8");
  fs.writeFileSync(path.join(resValuesDir, "strings.xml"), stringsXml, "utf-8");
}

export class PermissionLabManager {
  private readonly config: OpenPocketConfig;
  private readonly emulator: EmulatorManager;

  constructor(config: OpenPocketConfig) {
    this.config = config;
    this.emulator = new EmulatorManager(config);
  }

  get packageName(): string {
    return PACKAGE_NAME;
  }

  get mainActivity(): string {
    return MAIN_ACTIVITY;
  }

  get projectDir(): string {
    return path.join(this.config.stateDir, "test-apps", "permission-lab");
  }

  get buildDir(): string {
    return path.join(this.projectDir, "build");
  }

  listScenarios(): PermissionLabScenario[] {
    return PERMISSION_LAB_SCENARIOS.map((item) => ({ ...item }));
  }

  resolveScenario(scenarioId?: string | null): PermissionLabScenario {
    const normalized = (scenarioId ?? DEFAULT_PERMISSION_LAB_SCENARIO_ID).trim().toLowerCase();
    const found = PERMISSION_LAB_SCENARIOS.find((item) => item.id === normalized);
    if (!found) {
      const supported = PERMISSION_LAB_SCENARIOS.map((item) => item.id).join(", ");
      throw new Error(`Unknown permission-app scenario: ${scenarioId ?? "(empty)"}. Supported: ${supported}`);
    }
    return { ...found };
  }

  agentTaskForScenario(scenarioId?: string | null): string {
    const scenario = this.resolveScenario(scenarioId);
    if (scenario.id === "2fa") {
      return [
        "Open app OpenPocket PermissionLab.",
        "The app is launched in scenario mode where only the target case button is visible.",
        `Tap button "${scenario.buttonLabel}" exactly once.`,
        "Then call request_human_auth with capability=2fa and instruction='Please provide your current 2FA code in Telegram.'",
        "Wait for my decision from Telegram before doing anything else.",
        "After approval or rejection arrives, report the final result and whether the flow resumed.",
      ].join(" ");
    }

    const codeFlowHint =
      scenario.capability === "sms"
        ? "For SMS, ask me directly in Telegram for the verification code and wait."
        : "";

    return [
      "Open app OpenPocket PermissionLab.",
      "The app is launched in scenario mode where only the target case button is visible.",
      `Tap the visible "${scenario.buttonLabel}" button exactly once.`,
      "If emulator-local permission dialog appears, do not keep looping on it.",
      `Immediately call request_human_auth with capability=${scenario.capability} and wait for my decision.`,
      "For camera/location/qr style blocks, prefer real-device delegation data over emulator-local permission state.",
      "If delegated data is attached by human auth (text/geo/image), use it immediately to continue UI flow.",
      "For delegated image, follow gallery import template in history: tap upload/attach/gallery and pick the injected OpenPocket file from Downloads.",
      codeFlowHint,
      "After I approve/reject on phone, continue and report final permission outcome (GRANTED/DENIED/already granted).",
    ]
      .filter(Boolean)
      .join(" ");
  }

  recommendedTelegramTask(scenarioId?: string | null): string {
    const task = this.agentTaskForScenario(scenarioId);
    return [
      "/run",
      task,
    ].join(" ");
  }

  private ensureEmulatorReady(preferredDeviceId?: string): string {
    const status = this.emulator.status();
    if (preferredDeviceId) {
      if (!status.devices.includes(preferredDeviceId)) {
        throw new Error(`Device '${preferredDeviceId}' is not online. Online devices: ${status.devices.join(", ") || "(none)"}`);
      }
      return preferredDeviceId;
    }

    if (status.bootedDevices.length > 0) {
      return status.bootedDevices[0];
    }
    if (status.devices.length > 0) {
      return status.devices[0];
    }

    throw new Error("No running emulator found. Start one first with `openpocket emulator start`.");
  }

  async deploy(options: PermissionLabDeployOptions = {}): Promise<PermissionLabDeployResult> {
    if (options.clean) {
      fs.rmSync(this.buildDir, { recursive: true, force: true });
    }

    ensureDir(this.projectDir);
    ensureDir(this.buildDir);
    writePermissionLabSource(this.projectDir);

    const sdkRoot = detectSdkRoot(this.config);
    const { dir: buildToolsDir, version: buildToolsVersion } = pickBuildToolsDir(sdkRoot);
    const { androidJar, version: platformVersion } = pickPlatformAndroidJar(sdkRoot);

    const aapt2 = path.join(buildToolsDir, "aapt2");
    const zipalign = path.join(buildToolsDir, "zipalign");
    const apksigner = path.join(buildToolsDir, "apksigner");
    const javaHome = detectJavaHome17Plus();
    const buildEnv: NodeJS.ProcessEnv = javaHome
      ? {
          ...process.env,
          JAVA_HOME: javaHome,
          PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH || ""}`,
        }
      : process.env;
    const javaBinary = javaHome ? path.join(javaHome, "bin", "java") : "java";
    const javacBinary = javaHome ? path.join(javaHome, "bin", "javac") : "javac";
    const d8JarCandidates = [
      path.join(buildToolsDir, "lib", "d8.jar"),
      path.join(buildToolsDir, "d8.jar"),
    ];
    const d8Jar = d8JarCandidates.find((candidate) => fs.existsSync(candidate)) || "";
    if (!d8Jar) {
      throw new Error(`Unable to locate d8.jar in build-tools: ${buildToolsDir}`);
    }

    const compileResZip = path.join(this.buildDir, "compiled-res.zip");
    const genDir = path.join(this.buildDir, "gen");
    const classesDir = path.join(this.buildDir, "classes");
    const dexDir = path.join(this.buildDir, "dex");
    const unsignedApk = path.join(this.buildDir, "permission-lab-unsigned.apk");
    const alignedApk = path.join(this.buildDir, "permission-lab-aligned.apk");
    const signedApk = path.join(this.buildDir, "permission-lab-debug.apk");

    fs.rmSync(compileResZip, { force: true });
    fs.rmSync(genDir, { recursive: true, force: true });
    fs.rmSync(classesDir, { recursive: true, force: true });
    fs.rmSync(dexDir, { recursive: true, force: true });
    fs.rmSync(unsignedApk, { force: true });
    fs.rmSync(alignedApk, { force: true });
    fs.rmSync(signedApk, { force: true });
    ensureDir(genDir);
    ensureDir(classesDir);
    ensureDir(dexDir);

    requireCommandOk(
      aapt2,
      [
        "compile",
        "--dir",
        path.join(this.projectDir, "res"),
        "-o",
        compileResZip,
      ],
      "aapt2 compile resources",
      buildEnv,
    );

    requireCommandOk(
      aapt2,
      [
        "link",
        "-o",
        unsignedApk,
        "-I",
        androidJar,
        "--manifest",
        path.join(this.projectDir, "AndroidManifest.xml"),
        "--java",
        genDir,
        compileResZip,
      ],
      "aapt2 link",
      buildEnv,
    );

    const javaFiles = [
      ...collectFilesBySuffix(path.join(this.projectDir, "src"), ".java"),
      ...collectFilesBySuffix(genDir, ".java"),
    ];
    if (javaFiles.length === 0) {
      throw new Error("No Java source files found for PermissionLab build.");
    }

    requireCommandOk(
      javacBinary,
      [
        "-encoding",
        "UTF-8",
        "-source",
        "8",
        "-target",
        "8",
        "-bootclasspath",
        androidJar,
        "-classpath",
        androidJar,
        "-d",
        classesDir,
        ...javaFiles,
      ],
      "javac compile",
      buildEnv,
    );

    const classFiles = collectFilesBySuffix(classesDir, ".class");
    if (classFiles.length === 0) {
      throw new Error("javac did not produce .class files.");
    }

    requireCommandOk(
      javaBinary,
      [
        "-cp",
        d8Jar,
        "com.android.tools.r8.D8",
        "--lib",
        androidJar,
        "--output",
        dexDir,
        ...classFiles,
      ],
      "d8 dex",
      buildEnv,
    );

    const classesDex = path.join(dexDir, "classes.dex");
    if (!fs.existsSync(classesDex)) {
      throw new Error("d8 did not generate classes.dex.");
    }

    requireCommandOk(
      "/usr/bin/zip",
      [
        "-q",
        "-j",
        unsignedApk,
        classesDex,
      ],
      "zip add classes.dex",
      buildEnv,
    );

    requireCommandOk(
      zipalign,
      ["-f", "4", unsignedApk, alignedApk],
      "zipalign",
      buildEnv,
    );

    const debugKeystore = path.join(this.projectDir, "debug.keystore");
    if (!fs.existsSync(debugKeystore)) {
      const keytool = resolveKeytool(javaHome ?? undefined);
      requireCommandOk(
        keytool,
        [
          "-genkeypair",
          "-v",
          "-keystore",
          debugKeystore,
          "-storepass",
          "android",
          "-alias",
          "androiddebugkey",
          "-keypass",
          "android",
          "-keyalg",
          "RSA",
          "-keysize",
          "2048",
          "-validity",
          "10000",
          "-dname",
          "CN=Android Debug,O=Android,C=US",
        ],
        "keytool generate debug keystore",
        buildEnv,
      );
    }

    requireCommandOk(
      apksigner,
      [
        "sign",
        "--ks",
        debugKeystore,
        "--ks-key-alias",
        "androiddebugkey",
        "--ks-pass",
        "pass:android",
        "--key-pass",
        "pass:android",
        "--out",
        signedApk,
        alignedApk,
      ],
      "apksigner sign",
      buildEnv,
    );

    requireCommandOk(apksigner, ["verify", signedApk], "apksigner verify", buildEnv);

    const statusBeforeInstall = this.emulator.status();
    if (statusBeforeInstall.devices.length === 0) {
      await this.emulator.start(true);
    }
    const deviceId = this.ensureEmulatorReady(options.deviceId);
    const adb = this.emulator.adbBinary();
    const installArgs = ["-s", deviceId, "install", "-r", "-d", "-t", signedApk];
    let installOutput = "";
    const firstInstall = runCommand(adb, installArgs);
    if (firstInstall.status === 0 && !firstInstall.error) {
      installOutput = firstInstall.stdout.trim();
    } else {
      const detail = commandFailureDetail(firstInstall);
      if (!isAdbInstallUpdateIncompatible(detail)) {
        throw new Error(`adb install failed.\n${detail}`.trim());
      }

      const uninstallResult = runCommand(adb, ["-s", deviceId, "uninstall", PACKAGE_NAME]);
      if (uninstallResult.status !== 0 || uninstallResult.error) {
        const uninstallDetail = commandFailureDetail(uninstallResult);
        throw new Error(
          `adb install failed with signature mismatch, and uninstall recovery failed.\n${detail}\n${uninstallDetail}`.trim(),
        );
      }

      const retryInstall = runCommand(adb, installArgs);
      if (retryInstall.status !== 0 || retryInstall.error) {
        const retryDetail = commandFailureDetail(retryInstall);
        throw new Error(
          `adb install retry failed after uninstall recovery.\n${detail}\n${retryDetail}`.trim(),
        );
      }

      installOutput = [
        "Recovered from INSTALL_FAILED_UPDATE_INCOMPATIBLE by uninstalling existing package.",
        retryInstall.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n");
    }

    let launchOutput: string | null = null;
    if (options.launch ?? true) {
      launchOutput = requireCommandOk(
        adb,
        ["-s", deviceId, "shell", "am", "start", "-n", `${PACKAGE_NAME}/.MainActivity`],
        "adb launch",
      ).trim();
    }

    return {
      apkPath: signedApk,
      buildDir: this.buildDir,
      packageName: PACKAGE_NAME,
      mainActivity: MAIN_ACTIVITY,
      deviceId,
      installOutput,
      launchOutput,
      sdkRoot,
      buildToolsVersion,
      platformVersion,
    };
  }

  launch(preferredDeviceId?: string, scenarioId?: string | null): string {
    const deviceId = this.ensureEmulatorReady(preferredDeviceId);
    const adb = this.emulator.adbBinary();
    const normalizedScenario = (scenarioId || "").trim().toLowerCase();
    const args = ["-s", deviceId, "shell", "am", "start", "-n", `${PACKAGE_NAME}/.MainActivity`];
    if (normalizedScenario) {
      args.push("--es", SCENARIO_FILTER_EXTRA, normalizedScenario);
    }
    return requireCommandOk(
      adb,
      args,
      "adb launch PermissionLab",
    ).trim();
  }

  uninstall(preferredDeviceId?: string): string {
    const deviceId = this.ensureEmulatorReady(preferredDeviceId);
    const adb = this.emulator.adbBinary();
    return requireCommandOk(
      adb,
      ["-s", deviceId, "uninstall", PACKAGE_NAME],
      "adb uninstall PermissionLab",
    ).trim();
  }

  reset(preferredDeviceId?: string): string {
    const deviceId = this.ensureEmulatorReady(preferredDeviceId);
    const adb = this.emulator.adbBinary();

    requireCommandOk(adb, ["-s", deviceId, "shell", "am", "force-stop", PACKAGE_NAME], "adb force-stop");
    requireCommandOk(adb, ["-s", deviceId, "shell", "pm", "clear", PACKAGE_NAME], "adb pm clear");

    for (const permission of REQUESTED_PERMISSIONS) {
      const result = runCommand(adb, ["-s", deviceId, "shell", "pm", "revoke", PACKAGE_NAME, permission]);
      if (result.status !== 0) {
        continue;
      }
    }

    return `PermissionLab reset on ${deviceId}.`;
  }
}
