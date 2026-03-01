import assert from "node:assert/strict";
import test from "node:test";

const {
  adbConnectionLabel,
  filterOnlineTargetAdbDevices,
  parseAdbDevicesLongOutput,
} = await import("../dist/device/adb-device-discovery.js");

test("parseAdbDevicesLongOutput detects usb, wifi and emulator transports", () => {
  const output = [
    "List of devices attached",
    "5B050DLCH001LL device usb:1-1 product:blazer model:Pixel_10_Pro device:blazer transport_id:4",
    "192.168.1.80:5555 device product:atv model:Google_TV_Streamer transport_id:8",
    "emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:2",
    "",
  ].join("\n");
  const parsed = parseAdbDevicesLongOutput(output);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].connectionType, "usb");
  assert.equal(parsed[1].connectionType, "wifi");
  assert.equal(parsed[1].endpoint, "192.168.1.80:5555");
  assert.equal(parsed[2].connectionType, "emulator");
  assert.equal(adbConnectionLabel(parsed[1].connectionType), "WiFi ADB");
});

test("filterOnlineTargetAdbDevices keeps only online target-compatible devices", () => {
  const output = [
    "List of devices attached",
    "ABCUSB123 device usb:2-1 product:phone model:Pixel_10_Pro transport_id:3",
    "192.168.1.80:5555 offline product:atv model:Google_TV_Streamer transport_id:9",
    "emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:2",
    "",
  ].join("\n");
  const parsed = parseAdbDevicesLongOutput(output);
  const filteredPhysical = filterOnlineTargetAdbDevices(parsed, "physical-phone");
  assert.deepEqual(filteredPhysical.map((item) => item.deviceId), ["ABCUSB123"]);

  const filteredEmulator = filterOnlineTargetAdbDevices(parsed, "emulator");
  assert.deepEqual(filteredEmulator.map((item) => item.deviceId), ["emulator-5554"]);
});

