import { isProtectedLabel, targetEligibility } from "./acceptance-target.ts";
import { withAndroidChrome } from "./android-device.ts";

const PROMPT_MARKER = "OMP_POST_RELEASE_ANDROID_CONTROL_SMOKE";
const APP_ASSET_PATTERN = /^\/assets\/app\.[0-9a-f]+\.js$/u;

export interface AndroidCollabSmokeOptions {
  readonly origin: string;
  readonly label: string;
  readonly expectedAppAsset?: string;
  readonly allowDisposableTarget: boolean;
}

export interface AndroidCollabSmokeResult {
  readonly packageName: string;
  readonly androidPackageVersion: string;
  readonly appAsset: string;
  readonly viewReadOnly: true;
  readonly controlWritable: true;
  readonly promptAccepted: true;
  readonly returnedToDirectory: true;
}
interface SessionMetadata {
  readonly cwdLabel: string;
  readonly canView: boolean;
  readonly canControl: boolean;
  readonly startedAt?: string;
}


export function parseAndroidCollabSmokeArgs(argv: readonly string[]): AndroidCollabSmokeOptions {
  const positional: string[] = [];
  let expectedAppAsset: string | undefined;
  let allowDisposableTarget = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--disposable-target") {
      allowDisposableTarget = true;
      continue;
    }
    if (value === "--expected-app-asset") {
      expectedAppAsset = argv[++index];
      if (!expectedAppAsset) throw new Error("--expected-app-asset requires a path");
      continue;
    }
    if (value.startsWith("--")) throw new Error(`unknown option: ${value}`);
    positional.push(value);
  }

  if (positional.length !== 2) {
    throw new Error(
      "usage: bun scripts/android-collab-smoke.ts <origin> <disposable-label> [--expected-app-asset /assets/app.<hash>.js] [--disposable-target]",
    );
  }
  const [origin, label] = positional as [string, string];
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== "https:" || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) {
    throw new Error("origin must be an HTTPS origin without a path, query, or fragment");
  }
  if (isProtectedLabel(label)) throw new Error("refusing protected or soak target label");
  if (expectedAppAsset !== undefined && !APP_ASSET_PATTERN.test(expectedAppAsset)) {
    throw new Error("expected app asset must be a hashed /assets/app.*.js path");
  }

  return {
    origin: parsedOrigin.origin,
    label,
    ...(expectedAppAsset === undefined ? {} : { expectedAppAsset }),
    allowDisposableTarget,
  };
}

async function assertEligibleTarget(options: AndroidCollabSmokeOptions): Promise<void> {
  const response = await fetch(`${options.origin}/api/v1/sessions`, {
    cache: "no-store",
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`session-list preflight failed with HTTP ${response.status}`);
  const payload = (await response.json()) as { sessions?: SessionMetadata[] };
  const matches = (payload.sessions ?? []).filter(session => session.cwdLabel === options.label);
  if (matches.length !== 1) throw new Error(`expected exactly one disposable target; found ${matches.length}`);
  const target = matches[0]!;
  if (!target.canView || !target.canControl) throw new Error("disposable target lacks View or Control capability");
  const eligibility = targetEligibility(options.label, target.startedAt, Date.now(), options.allowDisposableTarget);
  if (!eligibility.eligible) throw new Error(eligibility.reason ?? "disposable target is ineligible");
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

export async function runAndroidCollabSmoke(options: AndroidCollabSmokeOptions): Promise<AndroidCollabSmokeResult> {
  await assertEligibleTarget(options);

  return withAndroidChrome(async driver => {
    await driver.openTab();
    await driver.navigate(`${options.origin}/`);

    const waitFor = async (name: string, expression: string, attempts = 60): Promise<void> => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await driver.evaluate<boolean>(expression).catch(() => false)) return;
        await pause(500);
      }
      throw new Error(`${name} did not become ready`);
    };

    const quotedLabel = JSON.stringify(options.label);
    await waitFor(
      "directory target",
      `Boolean([...document.querySelectorAll("button[aria-label]")].find(button => button.getAttribute("aria-label") === "View " + ${quotedLabel}))`,
    );

    const appAsset = await driver.evaluate<string | null>(
      `performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname).find(path => /^\\/assets\\/app\\.[0-9a-f]+\\.js$/.test(path)) ?? null`,
    );
    if (appAsset === null || !APP_ASSET_PATTERN.test(appAsset)) throw new Error("hashed app asset was not loaded");
    if (options.expectedAppAsset !== undefined && appAsset !== options.expectedAppAsset) {
      throw new Error("installed app asset does not match the release archive");
    }

    const openedView = await driver.evaluate<boolean>(`(() => {
      const button = [...document.querySelectorAll("button[aria-label]")].find(
        candidate => candidate.getAttribute("aria-label") === "View " + ${quotedLabel},
      );
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    if (!openedView) throw new Error("View action was unavailable");

    await waitFor(
      "View collaboration shell",
      `location.pathname === "/client/" && document.querySelector(".conn-chip")?.dataset.state === "connected" && document.querySelector(".sh-composer-input") instanceof HTMLTextAreaElement`,
      120,
    );
    const view = await driver.evaluate<{ readOnly: boolean; controlVisible: boolean; rootMounted: boolean }>(`(() => {
      const editor = document.querySelector(".sh-composer-input");
      const control = document.querySelector(".shell-control");
      return {
        readOnly: editor instanceof HTMLTextAreaElement && editor.disabled && editor.placeholder === "read-only session — watching only",
        controlVisible: control instanceof HTMLButtonElement && !control.hidden,
        rootMounted: document.querySelector("#root[role=application]") !== null,
      };
    })()`);
    if (!view.readOnly || !view.controlVisible || !view.rootMounted) throw new Error("View did not remain read-only");

    const upgraded = await driver.evaluate<boolean>(`(() => {
      const control = document.querySelector(".shell-control");
      if (!(control instanceof HTMLButtonElement) || control.hidden) return false;
      control.click();
      return true;
    })()`);
    if (!upgraded) throw new Error("Control upgrade action was unavailable");

    await waitFor(
      "Control collaboration shell",
      `document.querySelector(".conn-chip")?.dataset.state === "connected" && document.querySelector(".shell-control")?.hidden === true && document.querySelector(".sh-composer-input") instanceof HTMLTextAreaElement && !document.querySelector(".sh-composer-input").disabled`,
      120,
    );
    const control = await driver.evaluate<{ writable: boolean; sendInitiallyDisabled: boolean }>(`(() => {
      const editor = document.querySelector(".sh-composer-input");
      const send = document.querySelector('button[title="send (Enter)"]');
      return {
        writable: editor instanceof HTMLTextAreaElement && !editor.disabled && editor.placeholder === "prompt the host agent…",
        sendInitiallyDisabled: send instanceof HTMLButtonElement && send.disabled,
      };
    })()`);
    if (!control.writable || !control.sendInitiallyDisabled) throw new Error("Control composer was not writable");

    const drafted = await driver.evaluate<boolean>(`(() => {
      const editor = document.querySelector(".sh-composer-input");
      if (!(editor instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) return false;
      setter.call(editor, ${JSON.stringify(PROMPT_MARKER)});
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    if (!drafted) throw new Error("Control prompt could not be drafted");
    await waitFor("Control send", `document.querySelector('button[title="send (Enter)"]')?.disabled === false`);
    const sent = await driver.evaluate<boolean>(`(() => {
      const send = document.querySelector('button[title="send (Enter)"]');
      if (!(send instanceof HTMLButtonElement) || send.disabled) return false;
      send.click();
      return true;
    })()`);
    if (!sent) throw new Error("Control prompt could not be sent");
    await waitFor("Control prompt acceptance", `document.body.innerText.includes(${JSON.stringify(PROMPT_MARKER)})`, 60);

    await driver.evaluate(`(() => {
      const stop = document.querySelector(".sh-btn-stop");
      if (stop instanceof HTMLButtonElement && !stop.disabled) stop.click();
    })()`);

    const returned = await driver.evaluate<boolean>(`(() => {
      const back = document.querySelector(".shell-back");
      if (!(back instanceof HTMLButtonElement)) return false;
      back.click();
      return true;
    })()`);
    if (!returned) throw new Error("Sessions return action was unavailable");
    await waitFor(
      "directory return",
      `location.pathname === "/" && Boolean([...document.querySelectorAll("button[aria-label]")].find(button => button.getAttribute("aria-label") === "View " + ${quotedLabel}))`,
    );

    return {
      packageName: driver.packageName,
      androidPackageVersion: driver.androidPackageVersion,
      appAsset,
      viewReadOnly: true,
      controlWritable: true,
      promptAccepted: true,
      returnedToDirectory: true,
    };
  });
}

if (import.meta.main) {
  const result = await runAndroidCollabSmoke(parseAndroidCollabSmokeArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
