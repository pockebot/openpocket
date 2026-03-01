# Screen Awake Heartbeat

OpenPocket runs a dedicated keep-awake worker process so screen wake pulses are decoupled from the agent decision loop.

## Why It Exists

- phone screen timeout is user-controlled and can happen at any time
- if the screen turns off, interaction latency and lock-state handling become unstable
- keep-awake must continue even when model reasoning or task execution is busy

## Architecture

1. `AdbRuntime.startScreenAwakeHeartbeat(...)` starts an independent Node child process.
2. The worker receives runtime params (`adbPath`, target info, preferred device ID, interval).
3. The worker sends `adb shell input keyevent KEYCODE_WAKEUP` on a fixed interval.
4. The worker exits when parent exits (`process.ppid === 1`) or on stop signals.

This design isolates wakeup timing from main-loop load and avoids timer starvation inside the main runtime process.

## Interval and Configuration

- default interval: `3` seconds
- config key: `target.wakeupIntervalSec`
- CLI update:

```bash
openpocket target set --wakeup-interval <seconds>
```

Interval is normalized to a safe minimum (1 second).

## Timing Characteristics

The heartbeat is more stable than a main-loop timer but still not hard real-time:

- OS scheduling can delay timer callbacks
- transient `adb` contention can delay one cycle
- device transport reconnect (especially Wi-Fi ADB) can add jitter

Operational guidance:

- use `3s` for most devices
- use `1-2s` only when aggressive wake maintenance is needed
- if jitter is visible, check host load and ADB transport stability first
