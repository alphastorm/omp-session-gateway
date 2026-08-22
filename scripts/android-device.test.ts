import { describe, expect, test } from "bun:test";
import { parseAndroidPackageVersion, resolveAndroidBrowserTarget } from "./android-device.ts";

describe("Android browser target", () => {
  test("defaults to stable Chrome and its ordinary DevTools socket", () => {
    expect(resolveAndroidBrowserTarget({})).toEqual({
      packageName: "com.android.chrome",
      activity: "com.android.chrome/com.google.android.apps.chrome.Main",
      devtoolsSocket: "localabstract:chrome_devtools_remote",
    });
  });

  test("derives the activity from an alternate package while keeping every endpoint overrideable", () => {
    expect(resolveAndroidBrowserTarget({ OMP_ANDROID_BROWSER_PACKAGE: "com.chrome.canary" })).toEqual({
      packageName: "com.chrome.canary",
      activity: "com.chrome.canary/com.google.android.apps.chrome.Main",
      devtoolsSocket: "localabstract:chrome_devtools_remote",
    });
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
