import { findWebApkForHost } from "./post-release-smoke.ts";
import { readAndroidUi, type AndroidUiNode } from "./android-notification.ts";
import { withAndroidChrome, requireSingleDevice, parseKeyguardShowing, type AndroidAdbCommand } from "./android-device.ts";
import { withDevelopmentPixelLease } from "./android-pixel-lease.ts";

export function webApkTasks(activities: string, packageName: string): number[] {
  const ids = new Set<number>();
  for (const line of activities.split("\n")) {
    if (!line.includes(`:${packageName}`) || !/^\s*\* Task\{/u.test(line)) continue;
    const id = line.match(/Task\{[^\n]*?#(\d+)\b/u)?.[1];
    if (id !== undefined) ids.add(Number(id));
  }
  return [...ids];
}

/** Read-only admission. No origin or package dump is returned in evidence. */
export async function requireWebApk(command: AndroidAdbCommand, origin: string): Promise<string> {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "https:" || url.port !== "") throw new Error("Push needs an exact HTTPS Serve origin");
  const list = await command("shell", "cmd", "package", "list", "packages", "org.chromium.webapk");
  const dumps: Record<string, string> = {};
  for (const packageName of list.split(/\r?\n/u).map(line => line.trim().replace(/^package:/u, ""))) {
    if (/^org\.chromium\.webapk\.[A-Za-z0-9_.]+$/u.test(packageName)) {
      dumps[packageName] = await command("shell", "dumpsys", "package", packageName);
    }
  }
  const packageName = findWebApkForHost(list, dumps, url.hostname);
  if (packageName === undefined) throw new Error("WebAPK missing for this origin; run bun scripts/android-webapk.ts setup <origin> with the Pixel lease");
  return packageName;
}

export async function closeWebApk(command: AndroidAdbCommand, packageName: string, pause = (milliseconds: number) => Bun.sleep(milliseconds)): Promise<void> {
  for (const task of webApkTasks(await command("shell", "dumpsys", "activity", "activities"), packageName)) {
    await command("shell", "am", "stack", "remove", String(task));
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (webApkTasks(await command("shell", "dumpsys", "activity", "activities"), packageName).length === 0) return;
    await pause(250);
  }
  throw new Error("WebAPK task remained open");
}

export async function openWebApk(command: AndroidAdbCommand, packageName: string): Promise<void> {
  await command("shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1");
}

export interface WebApkSetupRuntime {
  command: AndroidAdbCommand;
  navigate(origin: string): Promise<void>;
  pause(milliseconds: number): Promise<void>;
}

/** One-time persistent equipment setup. Never called by lane run/cleanup; never uninstalls anything. */
export async function setupAndroidWebApk(origin: string, runtime: WebApkSetupRuntime): Promise<Record<string, boolean>> {
  try {
    await requireWebApk(runtime.command, origin);
    return { alreadyInstalled: true, installed: true };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("WebAPK missing")) throw error;
  }
  await runtime.navigate(origin);
  let ownsNativeUi = false;
  const click = async (name: string, resources: readonly string[]) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const matches = (await readAndroidUi(runtime.command)).filter(node => resources.some(resource =>
        node.resource.endsWith(`:id/${resource}`)));
      if (matches.length > 1) throw new Error(`WebAPK setup ${name} ambiguous`);
      const node = matches[0];
      if (node !== undefined) {
        if (name === "menu") ownsNativeUi = true;
        await runtime.command("shell", "input", "tap", String(node.x), String(node.y));
        return node;
      }
      await runtime.pause(250);
    }
    throw new Error(`WebAPK setup ${name} unavailable`);
  };
  try {
    await click("menu", ["menu_button"]);
    await click("install-entry", ["universal_install"]);
    const install = await click("install", ["option_text_install", "positive_button"]);
    if (install.resource.endsWith(":id/option_text_install")) await click("confirm", ["positive_button"]);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await requireWebApk(runtime.command, origin);
        return { alreadyInstalled: false, installed: true };
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("WebAPK missing")) throw error;
      }
      await runtime.pause(1_000);
    }
    throw new Error("WebAPK install did not complete in 60 observations");
  } finally {
    if (ownsNativeUi) {
      const setupSurface = (node: AndroidUiNode) => node.resource.endsWith(":id/app_menu_list") ||
        node.resource.endsWith(":id/option_text_install") || (node.resource.endsWith(":id/positive_button") && node.text === "Install");
      try {
        if ((await readAndroidUi(runtime.command)).some(setupSurface)) {
          await runtime.command("shell", "input", "keyevent", "4");
          if ((await readAndroidUi(runtime.command)).some(setupSurface)) throw new Error("setup surface remained open");
        }
      } catch {
        throw Object.assign(new Error("WebAPK setup native UI was not restored"), { pixelUnrestored: true });
      }
    }
  }
}

if (import.meta.main) {
  const [action, origin] = process.argv.slice(2);
  if (action !== "setup" || origin === undefined) throw new Error("usage: android-webapk.ts setup <origin>");
  const serial = await requireSingleDevice();
  const command: AndroidAdbCommand = async (...args) => {
    const child = Bun.spawn(["adb", "-s", serial, ...args], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error("WebAPK setup device command failed");
    return output;
  };
  let alreadyInstalled = false;
  try { await requireWebApk(command, origin); alreadyInstalled = true; }
  catch (error) { if (!(error instanceof Error) || !error.message.startsWith("WebAPK missing")) throw error; }
  if (alreadyInstalled) console.log(JSON.stringify({ alreadyInstalled: true, installed: true }));
  else {
    let restored = false;
    await withDevelopmentPixelLease("PushLane WebAPK-setup", async () => {
      const locked = parseKeyguardShowing(await command("shell", "dumpsys", "window"));
      const awake = /mWakefulness=Awake/u.test(await command("shell", "dumpsys", "power"));
      let nativeUiRestored = true;
      try {
        const result = await withAndroidChrome(driver => setupAndroidWebApk(origin, { command,
          navigate: async url => { await driver.openTab(); await driver.navigate(url); }, pause: milliseconds => Bun.sleep(milliseconds) }));
        console.log(JSON.stringify(result));
      } catch (error) {
        if (error !== null && typeof error === "object" && "pixelUnrestored" in error && error.pixelUnrestored === true) nativeUiRestored = false;
        throw error;
      } finally {
        try { await closeWebApk(command, await requireWebApk(command, origin)); }
        catch (error) { if (!(error instanceof Error) || !error.message.startsWith("WebAPK missing")) throw error; }
        if (locked || !awake) await command("shell", "input", "keyevent", "223");
        if (awake) await command("shell", "input", "keyevent", "224");
        for (let attempt = 0; attempt < 40; attempt += 1) {
          restored = nativeUiRestored && parseKeyguardShowing(await command("shell", "dumpsys", "window")) === locked &&
            /mWakefulness=Awake/u.test(await command("shell", "dumpsys", "power")) === awake;
          if (restored) break;
          await Bun.sleep(250);
        }
        if (!restored) throw new Error("WebAPK setup baseline was not restored; Pixel lock retained");
      }
    }, () => restored);
  }
}
