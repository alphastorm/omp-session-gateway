import { createHash } from "node:crypto";
import type { AndroidAdbCommand } from "./android-device.ts";
import type { SessionMetadata } from "../packages/protocol/src/types.ts";

export function trackUnchangedNotificationPost(posts: Map<string, { key: string; postedAt: number }>,
  session: Pick<SessionMetadata, "generation" | "inputRequired" | "ask">, kind: "attention" | "activity_stop",
  record: { key: string; postedAt: number }): void {
  // After resolution, the OS can still display the old request while its clear is in flight.
  // Different cleared requests are not one unchanged "no request" state.
  if (kind === "attention" && (!session.inputRequired || session.ask === undefined)) return;
  const state = `${session.generation}:${kind}:${session.ask?.requestId ?? "none"}`;
  const prior = posts.get(state);
  if (prior !== undefined && (prior.key !== record.key || prior.postedAt !== record.postedAt)) throw new Error("owned notification was posted again for unchanged authoritative state");
  if (prior === undefined) posts.set(state, { key: record.key, postedAt: record.postedAt });
}

export function notificationTopicDigest(topic: string): string {
  return createHash("sha256").update(topic).digest("hex");
}

/** Android prefixes Web Push tags; compare only valid topic suffixes, without saving their text. */
export function notificationMatchesDigest(tag: string, digest: string): boolean {
  const prefix = "omp-attention-";
  for (let index = tag.indexOf(prefix); index !== -1; index = tag.indexOf(prefix, index + 1)) {
    if (tag.length - index > prefix.length + 64) continue;
    const topic = tag.slice(index);
    if (/^omp-attention-[a-z0-9-]{8,64}$/u.test(topic) && notificationTopicDigest(topic) === digest) return true;
  }
  return false;
}

export interface AndroidUiNode {
  readonly text: string;
  readonly description: string;
  readonly resource: string;
  readonly systemInput: boolean;
  readonly parent: number | undefined;
  readonly x: number;
  readonly y: number;
}

/** XML is never saved or returned as evidence. Only callers' exact synthetic values are matched. */
export function parseAndroidUi(xml: string): AndroidUiNode[] {
  const nodes: AndroidUiNode[] = [];
  const parents: (number | undefined)[] = [];
  for (const node of xml.matchAll(/<\/?node\b[^>]*>/gu)) {
    if (node[0].startsWith("</")) { parents.pop(); continue; }
    const attributes = new Map([...node[0].matchAll(/([\w-]+)="([^"]*)"/gu)].map(match => [match[1], match[2] ?? ""]));
    const bounds = attributes.get("bounds")?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u);
    let parent = parents.at(-1);
    if (bounds !== undefined && bounds !== null && Number(bounds[3]) > Number(bounds[1]) && Number(bounds[4]) > Number(bounds[2])) {
      const decode = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
      nodes.push({ text: decode(attributes.get("text") ?? ""), description: decode(attributes.get("content-desc") ?? ""),
        resource: attributes.get("resource-id") ?? "", systemInput: attributes.get("package") === "com.android.systemui" && attributes.get("password") === "true", parent,
        x: Math.floor((Number(bounds[1]) + Number(bounds[3])) / 2), y: Math.floor((Number(bounds[2]) + Number(bounds[4])) / 2) });
      parent = nodes.length - 1;
    }
    if (!node[0].endsWith("/>")) parents.push(parent);
  }
  return nodes;
}

export async function readAndroidUi(command: AndroidAdbCommand): Promise<AndroidUiNode[]> {
  // /dev/tty is the exec-out stream, not a device-side XML file.
  const xml = await command("exec-out", "uiautomator", "dump", "/dev/tty");
  if (!xml.includes("<hierarchy")) throw new Error("Android UI observation unavailable");
  return parseAndroidUi(xml);
}

export interface NotificationObservation {
  readonly count: number;
  readonly titleMatches: boolean;
  readonly bodyMatches: boolean;
  readonly forbiddenFound: boolean;
}
export interface NotificationExpectation {
  readonly packageName: string; readonly tag: string; readonly title: string; readonly body: string; readonly forbidden: readonly string[];
  /** The owned origin's host, which Android shows in each WebAPK notification's row header. */
  readonly originHost: string;
}

/** Transient OS identities and content: never serialize these records as evidence. */
export interface AndroidNotificationRecord {
  readonly key: string; readonly tag: string; readonly postedAt: number;
  readonly seen: boolean; readonly visibleSince: number;
  readonly title: string; readonly body: string; readonly text: string;
}

export class NotificationOverlapError extends Error {
  constructor() { super("unowned notification overlapped the owned phase"); }
}

export function parseAndroidNotificationRecords(dump: string, packageName: string): AndroidNotificationRecord[] {
  const list = dump.split("Notification List:")[1]?.split(/\n\s*(?:Enqueued Notification List:|Snoozed notifications:|Notification history:|Ranking Config:)/u)[0];
  if (list === undefined) {
    if (dump.includes("Current Notification Manager state:") && dump.includes("Ranking Config:")) return [];
    throw new Error("Android notification list unavailable");
  }
  return list.split(/\n\s*NotificationRecord\(/u).slice(1).filter(record =>
    (record.split("\n", 1)[0] ?? "").includes(`pkg=${packageName} `)).map(record => {
      const key = record.match(/^\s*key=(\S+)/mu)?.[1];
      const tag = record.split("\n", 1)[0]?.match(/\btag=([^\s)]+)/u)?.[1];
      const postedAt = Number(record.match(/^\s*mUpdateTimeMs=(\d+)/mu)?.[1]);
      if (key === undefined || tag === undefined || !Number.isSafeInteger(postedAt) || postedAt <= 0) throw new Error("Android notification record identity unavailable");
      return { key, tag, postedAt, seen: /^\s*seen=true\s*$/mu.test(record),
        visibleSince: Number(record.match(/^\s*mVisibleSinceMs=(\d+)/mu)?.[1] ?? 0),
        title: record.match(/android\.title=String \(([^\n]*)\)/u)?.[1] ?? "",
        body: record.match(/android\.text=String \(([^\n]*)\)/u)?.[1] ?? "", text: record };
    });
}

export async function readAndroidNotificationRecords(command: AndroidAdbCommand, packageName: string): Promise<AndroidNotificationRecord[]> {
  return parseAndroidNotificationRecords(await command("exec-out", "dumpsys", "notification", "--noredact"), packageName);
}

export function observeNotificationDump(
  dump: string,
  expected: NotificationExpectation,
): NotificationObservation {
  const records = parseAndroidNotificationRecords(dump, expected.packageName).filter(record => record.tag.endsWith(expected.tag));
  return { count: records.length,
    titleMatches: records.length === 1 && records[0]!.title === expected.title,
    bodyMatches: records.length === 1 && records[0]!.body === expected.body,
    forbiddenFound: records.some(record => expected.forbidden.some(value => value.length > 0 && record.text.includes(value))),
  };
}

export async function observeAndroidNotification(
  command: AndroidAdbCommand,
  expected: NotificationExpectation,
): Promise<NotificationObservation> {
  const dump = await command("exec-out", "dumpsys", "notification", "--noredact");
  return observeNotificationDump(dump, expected);
}

interface LocatedNotification { readonly target: AndroidUiNode; readonly rowNodes: AndroidUiNode[]; readonly key: string; readonly postedAt: number; readonly peers: ReadonlyMap<string, number> }

export async function findAndroidNotification(command: AndroidAdbCommand, expected: NotificationExpectation, pause: (milliseconds: number) => Promise<void> = milliseconds => Bun.sleep(milliseconds)): Promise<LocatedNotification> {
  const records = await readAndroidNotificationRecords(command, expected.packageName);
  const owned = records.filter(record => record.tag.endsWith(expected.tag));
  if (owned.length !== 1 || owned[0]!.title !== expected.title || owned[0]!.body !== expected.body) throw new Error("owned notification record changed before UI observation");
  if (records.some(record => record.key !== owned[0]!.key && record.title === expected.title && record.body === expected.body)) throw new NotificationOverlapError();
  const text = expected.body || expected.title;
  await command("shell", "input", "keyevent", "224");
  await command("shell", "cmd", "statusbar", "expand-notifications");
  await pause(750);
  const size = [...(await command("shell", "wm", "size")).matchAll(/(\d+)x(\d+)/gu)].at(-1);
  if (size === undefined) throw new Error("Android display size unavailable");
  const x = String(Math.floor(Number(size[1]) / 2));
  const height = Number(size[2]);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await command("shell", "input", "keyevent", "224");
    const nodes = await readAndroidUi(command);
    const inside = (nodeIndex: number, ancestor: number) => {
      for (let index: number | undefined = nodeIndex; index !== undefined; index = nodes[index]!.parent) if (index === ancestor) return true;
      return false;
    };
    // The operator's daily OMP Sessions app shows the same Private title. Android names each WebAPK
    // notification's origin in its row header, but a collapsed group may show none.
    const origin = (nodeIndex: number): string | undefined => {
      for (let row: number | undefined = nodes[nodeIndex]!.parent; row !== undefined; row = nodes[row]!.parent) {
        if (!nodes[row]!.resource.endsWith(":id/expandableNotificationRow")) continue;
        const header = nodes.find((node, index) => node.resource === "android:id/header_text" && inside(index, row!));
        if (header !== undefined) return header.text;
      }
      return undefined;
    };
    // A row's template bounds its content. A collapsed group shows each child as one line with neither
    // that boundary nor the child's origin, so such a line is never selected; its group is expanded.
    const content = (nodeIndex: number): number | undefined => {
      for (let index = nodes[nodeIndex]!.parent; index !== undefined; index = nodes[index]!.parent) {
        if (nodes[index]!.resource === "android:id/status_bar_latest_event_content") return index;
      }
      return undefined;
    };
    // Prefer the row naming the owned origin, never one naming another, and fall back to rows without
    // a header only when no row names the owned origin.
    const candidates = (test: (node: AndroidUiNode) => boolean) => {
      const found = nodes.flatMap((node, index) => test(node) && content(index) !== undefined ? [{ node, origin: origin(index) }] : []);
      const owned = found.filter(item => item.origin === expected.originHost);
      return (owned.length > 0 ? owned : found.filter(item => item.origin === undefined)).map(item => item.node);
    };
    const exact = candidates(node => node.text === text);
    const matches = exact.length > 0 ? exact : candidates(node => node.description.includes(text));
    if (matches.length > 1) throw new Error("notification UI locator is ambiguous for the owned record");
    if (matches.length === 1) {
      const match = matches[0]!;
      const ancestors: number[] = [];
      for (let index: number | undefined = nodes.indexOf(match); index !== undefined; index = nodes[index]!.parent) ancestors.push(index);
      // Target the title in the child subtree identified by the synthetic body,
      // not a similarly titled group summary elsewhere in the hierarchy.
      let target = match;
      if (expected.body !== "") {
        for (const ancestor of ancestors) {
          const titles = nodes.filter((node, index) => node.text === expected.title && inside(index, ancestor));
          if (titles.length === 1) { target = titles[0]!; break; }
          if (titles.length > 1) throw new Error("owned notification child row is ambiguous");
        }
      }
      const boundary = content(nodes.indexOf(match))!;
      return { target, rowNodes: nodes.filter((_node, index) => inside(index, boundary)), key: owned[0]!.key, postedAt: owned[0]!.postedAt,
        peers: new Map(records.filter(record => record.tag.includes("omp-attention-") && record.key !== owned[0]!.key).map(record => [record.key, record.postedAt])) };
    }
    // Expand the first collapsed group with a one-line child showing the owned text or title; its
    // expand button is the one in its header, outside every child row.
    const collapsed = nodes.findIndex((node, index) => node.resource.endsWith(":id/notification_children_container") &&
      nodes.some((line, at) => (line.text === text || line.text === expected.title) && content(at) === undefined && inside(at, index)));
    const inGroupHeader = (nodeIndex: number) => {
      for (let index = nodes[nodeIndex]!.parent; index !== undefined && index !== collapsed; index = nodes[index]!.parent) {
        if (nodes[index]!.resource.endsWith(":id/expandableNotificationRow")) return false;
      }
      return true;
    };
    const group = collapsed === -1 ? undefined : nodes.find((node, index) => node.resource.endsWith("/expand_button") && inside(index, collapsed) && inGroupHeader(index));
    const headers = nodes.filter(node => node.text.includes("OMP Sessions") || node.description.includes("OMP Sessions"));
    const expand = nodes.filter((node, index) => node.resource.endsWith("/expand_button") && (origin(index) ?? expected.originHost) === expected.originHost &&
      headers.some(header => Math.abs(header.y - node.y) < 100));
    if (group !== undefined) await command("shell", "input", "tap", String(group.x), String(group.y));
    else if (expand.length === 1) await command("shell", "input", "tap", String(expand[0]!.x), String(expand[0]!.y));
    else await command("shell", "input", "swipe", x, String(Math.floor(height * 0.8)), x, String(Math.floor(height * 0.3)), "400");
    await pause(500);
  }
  throw new Error("owned notification absent from seven observed shade positions");
}

export async function tapAndroidNotification(command: AndroidAdbCommand, expected: NotificationExpectation, pause: (milliseconds: number) => Promise<void> = milliseconds => Bun.sleep(milliseconds)): Promise<void> {
  const found = await findAndroidNotification(command, expected, pause);
  const records = await readAndroidNotificationRecords(command, expected.packageName);
  const owned = records.filter(record => record.tag.endsWith(expected.tag));
  if (owned.length !== 1 || owned[0]!.key !== found.key || owned[0]!.postedAt !== found.postedAt) throw new Error("owned notification changed before tap");
  const peers = records.filter(record => record.tag.includes("omp-attention-") && record.key !== found.key);
  if (peers.length !== found.peers.size || peers.some(record => found.peers.get(record.key) !== record.postedAt)) throw new NotificationOverlapError();
  if (records.some(record => record.key !== owned[0]!.key && record.title === expected.title && record.body === expected.body)) throw new NotificationOverlapError();
  await command("shell", "input", "tap", String(found.target.x), String(found.target.y));
}
