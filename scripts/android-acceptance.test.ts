import { expect, test } from "bun:test";
import { withAndroidAcceptanceRestoration } from "./android-acceptance.ts";
import type { AndroidAdbCommand } from "./android-device.ts";

function radios() {
  const state = { airplane: false, wifi: true, mobile: false };
  const calls: string[] = [];
  const command: AndroidAdbCommand = async (...args) => {
    const call = args.join(" ");
    calls.push(call);
    if (args.includes("settings")) {
      const key = args.at(-1);
      if (key === "wifi_on") return state.wifi ? "1" : "0";
      if (key === "mobile_data") return state.mobile ? "1" : "0";
      if (key === "airplane_mode_on") return state.airplane ? "1" : "0";
      return "null";
    }
    if (args.includes("airplane-mode")) state.airplane = args.at(-1) === "enable";
    if (args.includes("wifi")) state.wifi = args.at(-1) === "enable";
    if (args.includes("data")) state.mobile = args.at(-1) === "enable";
    return "";
  };
  return { state, calls, command };
}

test("acceptance preserves the phase failure alongside a restoration failure and still resets Doze and battery", async () => {
  const device = radios();
  const phase = Object.assign(new Error("PWA did not recover"), { phase: "airplane" });
  const restoration = new Error("radio mutation failed");
  let failure: unknown;
  try {
    await withAndroidAcceptanceRestoration(async (...args) => {
      if (args.includes("wifi")) throw restoration;
      return device.command(...args);
    }, async () => { throw phase; });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toBe(phase);
  expect((failure as AggregateError).errors).toContain(restoration);
  expect(device.calls).toContain("shell dumpsys deviceidle unforce");
  expect(device.calls).toContain("shell dumpsys battery reset");
});

test("acceptance restores the Wi-Fi-on, data-off baseline rather than enabling roaming data", async () => {
  const device = radios();
  const result = await withAndroidAcceptanceRestoration(device.command, async () => {
    device.state.airplane = true;
    device.state.wifi = false;
    device.state.mobile = true;
    return "phase complete";
  });
  expect(result).toBe("phase complete");
  expect(device.state).toEqual({ airplane: false, wifi: true, mobile: false });
});

test("a successful adb response is not proof that acceptance restored the radio baseline", async () => {
  const device = radios();
  await expect(withAndroidAcceptanceRestoration(async (...args) => {
    if (args.includes("data")) return "";
    return device.command(...args);
  }, async () => { device.state.mobile = true; })).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: "radio baseline was not restored" })],
  });
  expect(device.calls).toContain("shell dumpsys deviceidle unforce");
  expect(device.calls).toContain("shell dumpsys battery reset");
});
