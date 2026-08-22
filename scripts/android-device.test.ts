import { describe, expect, test } from "bun:test";
import {
  assertDevtoolsEndpointMatchesPackage,
  assertBrowserVersionMatchesPackage,
  parseAndroidPackageVersion,
  resolveAndroidBrowserTarget,
  wakeAndroidChrome,
} from "./android-device.ts";

describe("Android browser target", () => {
  test("defaults to stable Chrome and its ordinary DevTools socket", () => {
    expect(resolveAndroidBrowserTarget({})).toEqual({
      packageName: "com.android.chrome",
      activity: "com.android.chrome/com.google.android.apps.chrome.Main",
      devtoolsSocket: "localabstract:chrome_devtools_remote",
    });
  });

  test("requires an explicit socket for an alternate package and keeps every endpoint overrideable", () => {
    expect(() => resolveAndroidBrowserTarget({ OMP_ANDROID_BROWSER_PACKAGE: "com.chrome.canary" })).toThrow(
      "OMP_ANDROID_DEVTOOLS_SOCKET is required for an alternate browser package",
    );
    expect(
      resolveAndroidBrowserTarget({
        OMP_ANDROID_BROWSER_PACKAGE: " org.chromium.chrome ",
        OMP_ANDROID_BROWSER_ACTIVITY: " org.chromium.chrome/org.chromium.chrome.browser.Main ",
        OMP_ANDROID_DEVTOOLS_SOCKET: " localabstract:canary_devtools_remote ",
      }),
    ).toEqual({
      packageName: "org.chromium.chrome",
      activity: "org.chromium.chrome/org.chromium.chrome.browser.Main",
      devtoolsSocket: "localabstract:canary_devtools_remote",
    });
  });

  test("rejects empty overrides instead of silently selecting the wrong browser", () => {
    for (const name of [
      "OMP_ANDROID_BROWSER_PACKAGE",
      "OMP_ANDROID_BROWSER_ACTIVITY",
      "OMP_ANDROID_DEVTOOLS_SOCKET",
    ]) {
      expect(() => resolveAndroidBrowserTarget({ [name]: "  " })).toThrow(`${name} must not be empty`);
    }
  });

  test("rejects selectors that can be interpreted by the Android shell", () => {
    expect(() =>
      resolveAndroidBrowserTarget({ OMP_ANDROID_BROWSER_PACKAGE: "com.chrome.canary;id" }),
    ).toThrow("OMP_ANDROID_BROWSER_PACKAGE must be an Android package name");
    expect(() =>
      resolveAndroidBrowserTarget({
        OMP_ANDROID_BROWSER_ACTIVITY: "com.other.chrome/com.google.android.apps.chrome.Main",
      }),
    ).toThrow("OMP_ANDROID_BROWSER_ACTIVITY must be a component in the selected package");
    expect(() =>
      resolveAndroidBrowserTarget({ OMP_ANDROID_DEVTOOLS_SOCKET: "localabstract:chrome;id" }),
    ).toThrow("OMP_ANDROID_DEVTOOLS_SOCKET must be a localabstract socket name");
  });
});
describe("Android display bootstrap", () => {
  const target = {
    packageName: "com.android.chrome",
    activity: "com.android.chrome/com.google.android.apps.chrome.Main",
    devtoolsSocket: "localabstract:chrome_devtools_remote",
  };

  test("wakes a dreaming display before the blocking Chrome Activity launch", async () => {
    const calls: string[][] = [];
    const wakefulness = ["Dreaming", "Awake"];
    await wakeAndroidChrome(
      "serial",
      target,
      async (...args) => {
        calls.push(args);
        if (args[1] === "dumpsys" && args[2] === "power") {
          return `mWakefulness=${wakefulness.shift() ?? "Awake"}`;
        }
        return "";
      },
      async () => {},
    );

    const launchIndex = calls.findIndex(args => args[1] === "am" && args[2] === "start");
    const awakeIndex = calls.findIndex(args => args.join(" ") === "shell dumpsys power" && calls.indexOf(args) > 2);
    expect(launchIndex).toBeGreaterThan(awakeIndex);
    expect(calls.slice(0, launchIndex)).toEqual([
      ["shell", "input", "keyevent", "224"],
      ["shell", "input", "keyevent", "82"],
      ["shell", "dumpsys", "power"],
      ["shell", "input", "keyevent", "224"],
      ["shell", "input", "keyevent", "82"],
      ["shell", "dumpsys", "power"],
    ]);
  });

  test("refuses to launch Chrome when the display never wakes", async () => {
    const calls: string[][] = [];
    const failure: unknown = await wakeAndroidChrome(
      "serial",
      target,
      async (...args) => {
        calls.push(args);
        return args[1] === "dumpsys" && args[2] === "power" ? "mWakefulness=Dreaming" : "";
      },
      async () => {},
    ).then(
      () => undefined,
      error => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Android display did not wake (observed Dreaming)");
    expect(calls.some(args => args[1] === "am" && args[2] === "start")).toBe(false);
  });
});

describe("Android package evidence", () => {
  test("extracts the installed package version from dumpsys output", () => {
    expect(
      parseAndroidPackageVersion(`Packages:\n  Package [com.chrome.canary]:\n    versionCode=801500000\n    versionName=154.0.8015.0\n`),
    ).toBe("154.0.8015.0");
  });

  test("refuses an evidence record without versionName", () => {
    expect(() => parseAndroidPackageVersion("Package [com.chrome.canary]\n  versionCode=801500000\n")).toThrow(
      "Android package metadata is missing versionName",
    );
  });
});

describe("Android package and DevTools binding", () => {
  test("accepts the same installed and CDP browser version", () => {
    expect(() =>
      assertBrowserVersionMatchesPackage("com.chrome.canary", "154.0.8015.0", {
        product: "Chrome/154.0.8015.0",
        revision: "@r1683520",
      }),
    ).not.toThrow();
  });

  test("rejects a DevTools socket owned by a different browser version", () => {
    expect(() =>
      assertBrowserVersionMatchesPackage("com.chrome.canary", "154.0.8015.0", {
        product: "Chrome/151.0.7922.171",
      }),
    ).toThrow('DevTools browser version does not match com.chrome.canary: "Chrome/151.0.7922.171" != "154.0.8015.0"');
  });
});

describe("Android DevTools endpoint ownership", () => {
  const metadata = {
    "Android-Package": "com.chrome.canary",
    Browser: "Chrome/154.0.8015.0",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser",
  };

  test("accepts endpoint metadata owned by the selected package and version", () => {
    expect(assertDevtoolsEndpointMatchesPackage("com.chrome.canary", "154.0.8015.0", metadata, 9222)).toBe(
      metadata.webSocketDebuggerUrl,
    );
  });

  test("rejects another package even when both packages share a Chrome version", () => {
    expect(() =>
      assertDevtoolsEndpointMatchesPackage("com.android.chrome", "154.0.8015.0", metadata, 9222),
    ).toThrow("DevTools socket is not owned by com.android.chrome");
  });

  test("rejects a WebSocket URL outside the exact local ADB forward", () => {
    expect(() =>
      assertDevtoolsEndpointMatchesPackage(
        "com.chrome.canary",
        "154.0.8015.0",
        { ...metadata, webSocketDebuggerUrl: "ws://example.invalid/devtools/browser" },
        9222,
      ),
    ).toThrow("DevTools endpoint WebSocket escaped the local ADB forward");
  });
});
