import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

import type { EmulatorStatus, OpenPocketConfig } from "../types.js";
import { ensureDir, nowForFilename } from "../utils/paths.js";
import { sleep } from "../utils/time.js";

export class EmulatorManager {
  private readonly config: OpenPocketConfig;
  private readonly stateDir: string;
  private readonly logFile: string;

  constructor(config: OpenPocketConfig) {
    this.config = config;
    this.stateDir = ensureDir(config.stateDir);
    this.logFile = path.join(this.stateDir, "emulator.log");
  }

  private sdkRoot(): string | null {
    if (this.config.emulator.androidSdkRoot.trim()) {
      return path.resolve(this.config.emulator.androidSdkRoot.trim());
    }
    if (process.env.ANDROID_SDK_ROOT?.trim()) {
      return path.resolve(process.env.ANDROID_SDK_ROOT);
    }
    if (process.env.ANDROID_HOME?.trim()) {
      return path.resolve(process.env.ANDROID_HOME);
    }
    return null;
  }

  emulatorBinary(): string {
    const sdkRoot = this.sdkRoot();
    if (sdkRoot) {
      const candidate = path.join(sdkRoot, "emulator", "emulator");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const fallback = [
      path.join(os.homedir(), "Library", "Android", "sdk", "emulator", "emulator"),
      "/opt/homebrew/share/android-commandlinetools/emulator/emulator",
      "/usr/local/share/android-commandlinetools/emulator/emulator",
    ];

    for (const candidate of fallback) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const fromPath = process.env.PATH?.split(path.delimiter)
      .map((p) => path.join(p, "emulator"))
      .find((p) => fs.existsSync(p));
    if (fromPath) {
      return fromPath;
    }

    throw new Error("Android emulator binary not found. Install Android SDK emulator first.");
  }

  adbBinary(): string {
    const sdkRoot = this.sdkRoot();
    if (sdkRoot) {
      const candidate = path.join(sdkRoot, "platform-tools", "adb");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const fromPath = process.env.PATH?.split(path.delimiter)
      .map((p) => path.join(p, "adb"))
      .find((p) => fs.existsSync(p));
    if (fromPath) {
      return fromPath;
    }

    throw new Error("adb not found. Install Android platform-tools first.");
  }

  listAvds(): string[] {
    const output = execFileSync(this.emulatorBinary(), ["-list-avds"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return output
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
  }

  private adb(args: string[], timeoutMs = 15000): string {
    const output = execFileSync(this.adbBinary(), args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return output;
  }

  emulatorDevices(): string[] {
    const output = this.adb(["devices"]);
    return output
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("emulator-") && line.includes("\tdevice"))
      .map((line) => line.split("\t", 1)[0]);
  }

  isBooted(deviceId: string): boolean {
    try {
      const output = this.adb(["-s", deviceId, "shell", "getprop", "sys.boot_completed"]);
      return output.trim() === "1";
    } catch {
      return false;
    }
  }

  status(): EmulatorStatus {
    const devices = this.emulatorDevices();
    const bootedDevices = devices.filter((d) => this.isBooted(d));
    return {
      avdName: this.config.emulator.avdName,
      devices,
      bootedDevices,
    };
  }

  private async waitForBoot(timeoutMs: number): Promise<EmulatorStatus> {
    const startAt = Date.now();
    let latest = this.status();
    while (Date.now() - startAt < timeoutMs) {
      latest = this.status();
      if (latest.bootedDevices.length > 0) {
        return latest;
      }
      await sleep(2000);
    }
    return this.status();
  }

  /**
   * Apply post-boot settings: high contrast, dark theme, suppress first-run dialogs,
   * pre-grant notification permissions, and disable captive portal checks.
   */
  private applyPostBootSettings(deviceId: string): void {
    const run = (args: string[]) => {
      try {
        this.runAdb(["-s", deviceId, ...args]);
      } catch {
        // best-effort
      }
    };

    // High contrast text + dark theme
    run(["shell", "settings", "put", "secure", "high_text_contrast_enabled", "1"]);
    run(["shell", "cmd", "uimode", "night", "yes"]);

    // Suppress first-run hints and setup wizard
    run(["shell", "settings", "put", "secure", "skip_first_use_hints", "1"]);
    run(["shell", "settings", "put", "global", "device_provisioned", "1"]);
    run(["shell", "settings", "put", "secure", "user_setup_complete", "1"]);

    // Disable notification popups and WiFi nags
    run(["shell", "settings", "put", "global", "heads_up_notifications_enabled", "0"]);
    run(["shell", "settings", "put", "global", "wifi_networks_available_notification_on", "0"]);

    // Disable captive portal detection (fixes "no internet" warning on emulator WiFi)
    run(["shell", "settings", "put", "global", "captive_portal_detection_enabled", "0"]);
    run(["shell", "settings", "put", "global", "captive_portal_mode", "0"]);

    // Pre-grant notification permission to common apps
    const commonApps = [
      "com.google.android.gm",
      "com.google.android.apps.photos",
      "com.google.android.youtube",
      "com.android.chrome",
      "com.google.android.apps.messaging",
      "com.google.android.calendar",
      "com.google.android.apps.maps",
    ];
    for (const pkg of commonApps) {
      run(["shell", "pm", "grant", pkg, "android.permission.POST_NOTIFICATIONS"]);
    }
  }

  private async waitForShutdown(timeoutMs: number): Promise<boolean> {
    const startAt = Date.now();
    while (Date.now() - startAt < timeoutMs) {
      if (this.emulatorDevices().length === 0) {
        return true;
      }
      await sleep(500);
    }
    return this.emulatorDevices().length === 0;
  }

  private hasEmulatorProcessForAvd(): boolean {
    const avdToken = `-avd ${this.config.emulator.avdName}`;
    return this.listProcessCommands().some((line) => {
      const isEmuProc = this.isRealEmulatorProcessCommand(line);
      return isEmuProc && line.includes(avdToken);
    });
  }

  private isRealEmulatorProcessCommand(line: string): boolean {
    const firstToken = line.split(/\s+/, 1)[0] ?? "";
    if (!firstToken) {
      return false;
    }
    const processName = path.basename(firstToken);
    if (!processName) {
      return false;
    }
    if (processName.startsWith("qemu-system")) {
      return true;
    }
    if (processName === "emulator" || processName === "emulator-headless") {
      return true;
    }
    return processName.includes("emulator");
  }

  private windowedQemuProcessNameMac(): string | null {
    if (process.platform !== "darwin") {
      return null;
    }
    const avdToken = `-avd ${this.config.emulator.avdName}`;
    for (const line of this.listProcessCommands()) {
      if (!line.includes(avdToken) || !this.isRealEmulatorProcessCommand(line) || !line.includes("qemu-system")) {
        continue;
      }
      const firstToken = line.split(/\s+/, 1)[0] ?? "";
      const processName = path.basename(firstToken);
      if (!processName || processName.includes("-headless")) {
        continue;
      }
      return processName;
    }
    return null;
  }

  private processVisibleMac(processName: string): boolean | null {
    if (process.platform !== "darwin") {
      return null;
    }
    const escaped = processName.replace(/"/g, '\\"');
    const output = spawnSync(
      "osascript",
      ["-e", `tell application "System Events" to get visible of application process "${escaped}"`],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (output.status !== 0) {
      return null;
    }
    const text = String(output.stdout ?? "")
      .trim()
      .toLowerCase();
    if (text === "true") {
      return true;
    }
    if (text === "false") {
      return false;
    }
    return null;
  }

  private setProcessVisibleMac(processName: string, visible: boolean, frontmost = false): boolean {
    if (process.platform !== "darwin") {
      return false;
    }
    const escaped = processName.replace(/"/g, '\\"');
    const scripts = [`tell application "System Events" to set visible of application process "${escaped}" to ${visible}`];
    if (visible && frontmost) {
      scripts.push(`tell application "System Events" to set frontmost of application process "${escaped}" to true`);
    }

    for (const script of scripts) {
      const result = spawnSync("osascript", ["-e", script], {
        stdio: "ignore",
      });
      if (result.status !== 0) {
        return false;
      }
    }
    return true;
  }

  private async waitForProcessVisibleMac(processName: string, visible: boolean, timeoutMs: number): Promise<boolean> {
    const startAt = Date.now();
    while (Date.now() - startAt < timeoutMs) {
      const current = this.processVisibleMac(processName);
      if (current === visible) {
        return true;
      }
      await sleep(200);
    }
    return this.processVisibleMac(processName) === visible;
  }

  private async waitForProcessExit(timeoutMs: number): Promise<boolean> {
    const startAt = Date.now();
    while (Date.now() - startAt < timeoutMs) {
      if (!this.hasEmulatorProcessForAvd()) {
        return true;
      }
      await sleep(500);
    }
    return !this.hasEmulatorProcessForAvd();
  }

  private listProcessCommands(): string[] {
    try {
      const output = execFileSync("ps", ["-ax", "-o", "command="], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
      });
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private isHeadlessProcessRunning(): boolean {
    const processes = this.listProcessCommands();
    if (processes.length === 0) {
      return false;
    }

    const avdToken = `-avd ${this.config.emulator.avdName}`;
    return processes.some(
      (line) =>
        this.isRealEmulatorProcessCommand(line) &&
        line.includes("-no-window") &&
        (line.includes(avdToken) || line.includes("-avd")),
    );
  }

  private forceKillHeadlessProcessMac(): boolean {
    if (process.platform !== "darwin") {
      return false;
    }
    try {
      spawnSync("pkill", ["-f", "qemu-system.*-no-window"], {
        stdio: "ignore",
      });
      spawnSync("pkill", ["-f", "emulator.*-no-window"], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  private forceKillEmulatorProcessForAvdMac(): boolean {
    if (process.platform !== "darwin") {
      return false;
    }
    try {
      const escapedAvd = this.config.emulator.avdName.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&");
      spawnSync("pkill", ["-f", `qemu-system.*-avd ${escapedAvd}`], {
        stdio: "ignore",
      });
      spawnSync("pkill", ["-f", `emulator.*-avd ${escapedAvd}`], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  private async restartWithMode(headless: boolean, reason: string): Promise<string> {
    const devicesBeforeStop = this.emulatorDevices();
    const stopMessage = this.stop();
    let stopped = await this.waitForShutdown(20000);
    let processStopped = await this.waitForProcessExit(5000);
    let forcedKill = false;

    if ((!stopped || !processStopped) && devicesBeforeStop.length > 0) {
      for (const device of devicesBeforeStop) {
        try {
          this.adb(["-s", device, "emu", "kill"]);
        } catch {
          // Keep trying best effort.
        }
      }
      stopped = await this.waitForShutdown(10000);
      processStopped = await this.waitForProcessExit(5000);
    }

    if (!stopped || !processStopped) {
      forcedKill = this.forceKillHeadlessProcessMac();
      if (forcedKill) {
        stopped = await this.waitForShutdown(8000);
        processStopped = await this.waitForProcessExit(6000);
      }
    }

    if (!stopped || !processStopped) {
      forcedKill = this.forceKillEmulatorProcessForAvdMac() || forcedKill;
      if (forcedKill) {
        stopped = await this.waitForShutdown(8000);
        processStopped = await this.waitForProcessExit(8000);
      }
    }

    const startMessage = await this.start(headless);
    const showMessage = headless ? null : this.showWindow();
    return [
      reason,
      stopMessage,
      forcedKill ? "Applied force-kill fallback for emulator process." : null,
      startMessage,
      headless ? "Switched to headless mode." : showMessage,
    ]
      .filter((item): item is string => Boolean(item))
      .join(" ");
  }

  async start(headless?: boolean): Promise<string> {
    const timeoutMs = Math.max(20, this.config.emulator.bootTimeoutSec) * 1000;
    const status = this.status();
    if (status.devices.length > 0) {
      if (status.bootedDevices.length > 0) {
        return `Emulator already running: ${status.bootedDevices.join(", ")}`;
      }

      const waited = await this.waitForBoot(timeoutMs);
      if (waited.bootedDevices.length > 0) {
        return `Emulator booted: ${waited.bootedDevices.join(", ")}`;
      }
      return `Emulator already running (${status.devices.join(", ")}), but boot is still in progress.`;
    }

    const avds = this.listAvds();
    if (avds.length === 0) {
      throw new Error("No AVD found. Create one with avdmanager first.");
    }

    let avdName = this.config.emulator.avdName;
    let fallback = false;
    if (!avds.includes(avdName)) {
      avdName = avds[0];
      fallback = true;
    }

    const useHeadless = headless ?? this.config.emulator.headless;
    const args = ["-avd", avdName, "-gpu", "auto"];
    if (useHeadless) {
      args.push("-no-window");
    }
    if (Array.isArray(this.config.emulator.extraArgs)) {
      args.push(
        ...this.config.emulator.extraArgs
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0),
      );
    }

    ensureDir(path.dirname(this.logFile));
    const marker = `\n=== ${nowForFilename()} start ${this.emulatorBinary()} ${args.join(" ")} ===\n`;
    fs.appendFileSync(this.logFile, marker, "utf-8");

    const fd = fs.openSync(this.logFile, "a");
    try {
      const child = spawn(this.emulatorBinary(), args, {
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
    } finally {
      fs.closeSync(fd);
    }

    const waited = await this.waitForBoot(timeoutMs);
    if (waited.bootedDevices.length > 0) {
      this.applyPostBootSettings(waited.bootedDevices[0]);
      const prefix = fallback
        ? `Configured AVD '${this.config.emulator.avdName}' not found; used '${avdName}'. `
        : "";
      return `${prefix}Emulator booted: ${waited.bootedDevices.join(", ")}`;
    }

    return "Emulator process started, but boot is still in progress.";
  }

  stop(): string {
    const devices = this.emulatorDevices();
    if (devices.length === 0) {
      return "No running emulator found.";
    }
    for (const device of devices) {
      try {
        this.adb(["-s", device, "emu", "kill"]);
      } catch {
        // Keep trying to stop other devices.
      }
    }
    return `Stop signal sent to: ${devices.join(", ")}`;
  }

  hideWindow(): string {
    if (process.platform !== "darwin") {
      return "hide-window currently supports macOS only.";
    }
    const processName = this.windowedQemuProcessNameMac();
    if (processName && this.setProcessVisibleMac(processName, false, false)) {
      return "Android Emulator window hidden.";
    }

    spawnSync("osascript", ["-e", 'tell application "Android Emulator" to hide'], { stdio: "ignore" });
    spawnSync("osascript", ["-e", 'tell application id "com.google.android.emulator" to hide'], { stdio: "ignore" });
    return "Android Emulator window hidden.";
  }

  showWindow(): string {
    if (process.platform !== "darwin") {
      return "show-window currently supports macOS only.";
    }
    const processName = this.windowedQemuProcessNameMac();
    if (processName && this.setProcessVisibleMac(processName, true, true)) {
      return "Android Emulator window activated.";
    }

    spawnSync("osascript", ["-e", 'tell application "Android Emulator" to activate'], { stdio: "ignore" });
    spawnSync("osascript", ["-e", 'tell application id "com.google.android.emulator" to activate'], { stdio: "ignore" });
    return "Android Emulator window activated.";
  }

  private hasVisibleWindowMac(): boolean {
    if (process.platform !== "darwin") {
      return false;
    }
    const processName = this.windowedQemuProcessNameMac();
    if (!processName) {
      return false;
    }
    return this.processVisibleMac(processName) === true;
  }

  private async waitForVisibleWindowMac(timeoutMs: number): Promise<boolean> {
    const startAt = Date.now();
    while (Date.now() - startAt < timeoutMs) {
      if (this.hasVisibleWindowMac()) {
        return true;
      }
      await sleep(200);
    }
    return this.hasVisibleWindowMac();
  }

  /**
   * Ensures the emulator is interactable in a desktop window.
   * If the process is currently headless (-no-window), it is restarted in windowed mode.
   */
  async ensureWindowVisible(): Promise<string> {
    if (process.platform !== "darwin") {
      return this.showWindow();
    }

    const status = this.status();
    if (status.devices.length === 0) {
      if (this.hasEmulatorProcessForAvd()) {
        return this.restartWithMode(false, "Emulator process exists without an online device; restarting in windowed mode.");
      }
      const startMessage = await this.start(false);
      const showMessage = this.showWindow();
      return `${startMessage}; ${showMessage}`;
    }

    if (this.isHeadlessProcessRunning()) {
      return this.restartWithMode(false, "Detected headless emulator runtime; switching to windowed mode.");
    }

    const showMessage = this.showWindow();
    const processName = this.windowedQemuProcessNameMac();
    if (processName) {
      const visible = await this.waitForProcessVisibleMac(processName, true, 1200);
      if (visible) {
        return showMessage;
      }
    }
    const becameVisible = await this.waitForVisibleWindowMac(1500);
    if (becameVisible) {
      return showMessage;
    }

    return this.restartWithMode(false, "No visible emulator window detected; restarting in windowed mode.");
  }

  async ensureHiddenBackground(): Promise<string> {
    if (process.platform !== "darwin") {
      return this.hideWindow();
    }

    const status = this.status();
    if (status.devices.length === 0) {
      if (this.isHeadlessProcessRunning()) {
        return "Emulator is already running in background (headless).";
      }
      if (this.hasEmulatorProcessForAvd()) {
        return this.restartWithMode(true, "Emulator process exists without an online device; restarting in headless mode.");
      }
      return "No running emulator found.";
    }

    if (this.isHeadlessProcessRunning()) {
      return "Emulator is already running in background (headless).";
    }

    const processName = this.windowedQemuProcessNameMac();
    if (processName && this.setProcessVisibleMac(processName, false, false)) {
      const hidden = await this.waitForProcessVisibleMac(processName, false, 1200);
      if (hidden) {
        return "Android Emulator window hidden.";
      }
    }

    return this.restartWithMode(true, "Hide could not hide the current window process; switching emulator to headless background mode.");
  }

  /**
   * Hide the emulator window without changing process mode.
   * This never restarts to headless fallback.
   */
  async hideWindowInPlace(): Promise<string> {
    if (process.platform !== "darwin") {
      return this.hideWindow();
    }

    const status = this.status();
    if (status.devices.length === 0) {
      if (this.isHeadlessProcessRunning()) {
        return "Emulator is already running in headless mode.";
      }
      return "No running emulator found.";
    }

    if (this.isHeadlessProcessRunning()) {
      return "Emulator is running in headless mode, no window to hide.";
    }

    const processName = this.windowedQemuProcessNameMac();
    if (!processName) {
      return "Windowed emulator process was not detected.";
    }
    if (this.setProcessVisibleMac(processName, false, false)) {
      const hidden = await this.waitForProcessVisibleMac(processName, false, 1200);
      if (hidden) {
        return "Android Emulator window hidden.";
      }
    }

    return "Failed to hide emulator window in-place. Keep current window or use headless fallback.";
  }

  captureScreenshot(outputPath?: string, preferredDeviceId?: string): string {
    const deviceId = this.resolveOnlineDevice(preferredDeviceId);

    const targetPath = outputPath
      ? path.resolve(outputPath)
      : path.join(this.stateDir, `screenshot-${deviceId}-${nowForFilename()}.png`);
    ensureDir(path.dirname(targetPath));

    const data = this.captureScreenshotPngBuffer(deviceId);

    fs.writeFileSync(targetPath, data);
    return targetPath;
  }

  captureScreenshotBuffer(preferredDeviceId?: string): { deviceId: string; data: Buffer } {
    const deviceId = this.resolveOnlineDevice(preferredDeviceId);

    const data = this.captureScreenshotPngBuffer(deviceId);

    return { deviceId, data };
  }

  tap(x: number, y: number, preferredDeviceId?: string): string {
    const deviceId = this.resolveOnlineDevice(preferredDeviceId);
    const tx = Math.max(0, Math.round(x));
    const ty = Math.max(0, Math.round(y));
    this.adb(["-s", deviceId, "shell", "input", "tap", String(tx), String(ty)]);
    return `Tap sent to ${deviceId} at (${tx}, ${ty}).`;
  }

  typeText(text: string, preferredDeviceId?: string): string {
    const deviceId = this.resolveOnlineDevice(preferredDeviceId);
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.trim()) {
      throw new Error("Text input is empty.");
    }

    const lines = normalized.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.length > 0) {
        if (this.hasNonAscii(line)) {
          this.inputByClipboardPaste(deviceId, line);
        } else {
          const encoded = this.encodeAdbInputText(line);
          try {
            this.adb(["-s", deviceId, "shell", "input", "text", encoded]);
          } catch {
            this.inputByClipboardPaste(deviceId, line);
          }
        }
      }
      if (i < lines.length - 1) {
        this.adb(["-s", deviceId, "shell", "input", "keyevent", "KEYCODE_ENTER"]);
      }
    }

    return `Text input sent to ${deviceId}.`;
  }

  private hasNonAscii(text: string): boolean {
    return /[^\x00-\x7F]/.test(text);
  }

  private inputByClipboardPaste(deviceId: string, text: string): void {
    this.adb(["-s", deviceId, "shell", "cmd", "clipboard", "set", "text", text]);
    this.adb(["-s", deviceId, "shell", "input", "keyevent", "KEYCODE_PASTE"]);
  }

  private resolveOnlineDevice(preferredDeviceId?: string): string {
    const devices = this.emulatorDevices();
    if (devices.length === 0) {
      throw new Error("No running emulator found.");
    }
    const deviceId = preferredDeviceId ?? devices[0];
    if (!devices.includes(deviceId)) {
      throw new Error(`Device '${deviceId}' is not online. Online devices: ${devices.join(", ")}`);
    }
    return deviceId;
  }

  private encodeAdbInputText(text: string): string {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/ /g, "%s")
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/&/g, "\\&")
      .replace(/\|/g, "\\|")
      .replace(/</g, "\\<")
      .replace(/>/g, "\\>")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/;/g, "\\;");
  }

  private captureScreenshotPngBuffer(deviceId: string): Buffer {
    try {
      return execFileSync(this.adbBinary(), ["-s", deviceId, "exec-out", "screencap", "-p"], {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 128 * 1024 * 1024,
        timeout: 15000,
      });
    } catch {
      const remote = `/sdcard/openpocket-screen-${nowForFilename()}.png`;
      const local = path.join(this.stateDir, `tmp-${deviceId}-${nowForFilename()}.png`);
      execFileSync(this.adbBinary(), ["-s", deviceId, "shell", "screencap", "-p", remote], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8 * 1024 * 1024,
        timeout: 20000,
      });
      execFileSync(this.adbBinary(), ["-s", deviceId, "pull", remote, local], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8 * 1024 * 1024,
        timeout: 20000,
      });
      try {
        execFileSync(this.adbBinary(), ["-s", deviceId, "shell", "rm", remote], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4 * 1024 * 1024,
          timeout: 10000,
        });
      } catch {
        // Ignore cleanup failure.
      }
      const data = fs.readFileSync(local);
      fs.unlinkSync(local);
      return data;
    }
  }

  runAdb(args: string[], timeoutMs = 20000): string {
    return this.adb(args, timeoutMs);
  }
}
