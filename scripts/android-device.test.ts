import { describe, expect, test } from "bun:test";
import {
  ANDROID_DIRECTORY_SURFACE_EXPRESSION,
  ANDROID_QUALIFICATION_PIN_KEYCHAIN_SERVICE,
  assertDevtoolsEndpointMatchesPackage,
  assertBrowserVersionMatchesPackage,
  parseAndroidPackageVersion,
  parseKeyguardShowing,
  readAndroidQualificationPin,
  unlockAndroidKeyguard,
  wakeAndroidDisplay,
  resolveAndroidBrowserTarget,
  wakeAndroidChrome,
} from "./android-device.ts";
describe("Android directory recovery observation", () => {
  test("reads rendered recovery state without issuing a competing fetch", () => {
    let fetchCalls = 0;
    const evaluate = new Function(
      "document",
      "navigator",
      "performance",
      "fetch",
      `return ${ANDROID_DIRECTORY_SURFACE_EXPRESSION};`,
    ) as (
      document: unknown,
      navigator: unknown,
      performance: unknown,
      fetch: () => never,
    ) => Record<string, unknown>;
    const status = {
      dataset: { kind: "ready" },
      hasAttribute: (name: string) => name === "hidden",
      querySelector: () => ({ textContent: "" }),
    };
    const observed = evaluate(
      {
        visibilityState: "visible",
        querySelector: () => status,
        querySelectorAll: () => ({ length: 1 }),
      },
      { onLine: false },
      { timeOrigin: 123_456, getEntriesByType: () => [{ name: "https://sessions.example/assets/app.abc123.js" }] },
      () => {
        fetchCalls += 1;
        throw new Error("recovery observer must not fetch");
      },
    );

    expect(fetchCalls).toBe(0);
    expect(observed).toMatchObject({
      online: false,
      visibility: "visible",
      statusHidden: true,
      statusKind: "ready",
      sessionCount: 1,
      appAsset: "https://sessions.example/assets/app.abc123.js",
      pageTimeOrigin: 123_456,
      directoryReady: true,
      outageVisible: false,
    });
  });
});


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
        if (args[1] === "dumpsys" && args[2] === "window") return "isKeyguardShowing=false";
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
      ["shell", "wm", "dismiss-keyguard"],
      ["shell", "dumpsys", "power"],
      ["shell", "input", "keyevent", "224"],
      ["shell", "input", "keyevent", "82"],
      ["shell", "wm", "dismiss-keyguard"],
      ["shell", "dumpsys", "power"],
      ["shell", "dumpsys", "window"],
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

  test("parses keyguard state and rejects missing state", () => {
    expect(parseKeyguardShowing("  isKeyguardShowing=true\n")).toBe(true);
    expect(parseKeyguardShowing("isKeyguardShowing=false\n")).toBe(false);
    expect(() => parseKeyguardShowing("mWakefulness=Awake")).toThrow(
      "Android window state is missing isKeyguardShowing",
    );
  });

  test("reveals the PIN keypad and authenticates once before reporting the display awake", async () => {
    const calls: string[][] = [];
    let keyguardChecks = 0;
    let unlocks = 0;
    const state = await wakeAndroidDisplay(
      async (...args) => {
        calls.push(args);
        if (args.join(" ") === "shell dumpsys power") return "mWakefulness=Awake";
        if (args.join(" ") === "shell wm size") return "Physical size: 1080x2424";
        if (args.join(" ") === "shell dumpsys window") {
          keyguardChecks += 1;
          return `isKeyguardShowing=${keyguardChecks === 1}`;
        }
        return "";
      },
      async () => {},
      async () => {
        unlocks += 1;
      },
    );
    expect(state).toBe("Awake");
    expect(unlocks).toBe(1);
    expect(keyguardChecks).toBe(2);
    expect(calls).toContainEqual(["shell", "input", "swipe", "540", "2205", "540", "606", "600"]);
  });

  test("fails closed when one authentication attempt leaves the keyguard visible", async () => {
    let unlocks = 0;
    const state = await wakeAndroidDisplay(
      async (...args) => {
        if (args.join(" ") === "shell dumpsys power") return "mWakefulness=Awake";
        if (args.join(" ") === "shell wm size") return "Physical size: 1080x2424";
        if (args.join(" ") === "shell dumpsys window") return "isKeyguardShowing=true";
        return "";
      },
      async () => {},
      async () => {
        unlocks += 1;
      },
    );
    expect(state).toBe("Keyguard");
    expect(unlocks).toBe(1);
  });

  test("rejects an unbounded display gesture before reading the credential", async () => {
    let unlocks = 0;
    const failure = await wakeAndroidDisplay(
      async (...args) => {
        if (args.join(" ") === "shell dumpsys power") return "mWakefulness=Awake";
        if (args.join(" ") === "shell dumpsys window") return "isKeyguardShowing=true";
        if (args.join(" ") === "shell wm size") return "Physical size: 2424x1080";
        return "";
      },
      async () => {},
      async () => {
        unlocks += 1;
      },
    ).then(
      () => undefined,
      error => error as Error,
    );
    expect(failure?.message).toBe("Android keyguard authentication failed");
    expect(unlocks).toBe(0);
  });
});

describe("Android secure keyguard unlock", () => {
  test("retrieves a device-scoped numeric PIN and clears the Keychain buffer", async () => {
    const keychainBytes = new TextEncoder().encode("9071\n");
    const pin = await readAndroidQualificationPin("pixel-serial", async (account, service) => {
      expect(account).toBe("pixel-serial");
      expect(service).toBe(ANDROID_QUALIFICATION_PIN_KEYCHAIN_SERVICE);
      return keychainBytes;
    });
    expect(new TextDecoder().decode(pin)).toBe("9071");
    expect([...keychainBytes]).toEqual([0, 0, 0, 0, 0]);
    pin.fill(0);
  });

  test("sends PIN digits through one interactive adb shell stream and clears memory", async () => {
    const pin = new TextEncoder().encode("9071");
    let observedSerial = "";
    let observedInput = new Uint8Array();
    await unlockAndroidKeyguard(
      "pixel-serial",
      async () => pin,
      async (serial, input) => {
        observedSerial = serial;
        observedInput = input.slice();
        return 0;
      },
    );
    expect(observedSerial).toBe("pixel-serial");
    expect(new TextDecoder().decode(observedInput)).toBe(
      "input keyevent KEYCODE_9\n" +
        "input keyevent KEYCODE_0\n" +
        "input keyevent KEYCODE_7\n" +
        "input keyevent KEYCODE_1\n" +
        "input keyevent KEYCODE_ENTER\n" +
        "exit\n",
    );
    expect([...pin]).toEqual([0, 0, 0, 0]);
    observedInput.fill(0);
  });

  test("redacts invalid credentials and adb transport failures", async () => {
    const invalidBytes = new TextEncoder().encode("12x4");
    const invalidFailure = await readAndroidQualificationPin("pixel-serial", async () => invalidBytes).then(
      () => undefined,
      error => error as Error,
    );
    expect(invalidFailure?.message).toBe("Android keyguard authentication failed");
    expect([...invalidBytes]).toEqual([0, 0, 0, 0]);

    const pin = new TextEncoder().encode("8675309");
    const transportFailure = await unlockAndroidKeyguard(
      "pixel-serial",
      async () => pin,
      async () => {
        throw new Error("transport exposed 8675309");
      },
    ).then(
      () => undefined,
      error => error as Error,
    );
    expect(transportFailure?.message).toBe("Android keyguard authentication failed");
    expect(transportFailure?.message).not.toContain("8675309");
    expect([...pin]).toEqual([0, 0, 0, 0, 0, 0, 0]);
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
