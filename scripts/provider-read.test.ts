import { expect, test } from "bun:test";
import { confirmAbsence, readProvider } from "./provider-read.ts";

const replies = (statuses: readonly number[]) => {
  const queue = [...statuses];
  let reads = 0;
  return {
    read: async () => { reads += 1; return new Response(null, { status: queue.shift() ?? 599 }); },
    reads: () => reads,
  };
};

test("a provider read survives a transient 5xx with bounded backoff", async () => {
  const provider = replies([502, 503, 200]);
  const delays: number[] = [];
  const response = await readProvider(provider.read, { sleep: async milliseconds => void delays.push(milliseconds) });
  expect(response.status).toBe(200);
  expect(provider.reads()).toBe(3);
  expect(delays).toEqual([2_000, 4_000]);
});

test("a persistent 5xx reaches the caller after five reads spanning half a minute, without a final sleep", async () => {
  const provider = replies([502, 502, 502, 502, 502, 200]);
  const delays: number[] = [];
  const response = await readProvider(provider.read, { sleep: async milliseconds => void delays.push(milliseconds) });
  expect(response.status).toBe(502);
  expect(provider.reads()).toBe(5);
  expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
});

test("a client error or a missing object is final at once", async () => {
  for (const status of [404, 401, 429]) {
    const provider = replies([status, 200]);
    const delays: number[] = [];
    expect((await readProvider(provider.read, { sleep: async milliseconds => void delays.push(milliseconds) })).status).toBe(status);
    expect([provider.reads(), delays.length]).toEqual([1, 0]);
  }
});

test("an owned resource is absent only when a second read agrees", async () => {
  const delays: number[] = [];
  const sleep = async (milliseconds: number) => void delays.push(milliseconds);
  const flicker: Array<string | undefined> = [undefined, "owned"];
  expect(await confirmAbsence(async () => flicker.shift(), { sleep })).toBe("owned");
  const gone: Array<string | undefined> = [undefined, undefined, "never read"];
  expect(await confirmAbsence(async () => gone.shift(), { sleep })).toBeUndefined();
  expect(gone).toEqual(["never read"]);
  const present = ["owned"];
  expect(await confirmAbsence(async () => present.shift(), { sleep })).toBe("owned");
  expect(delays).toEqual([5_000, 5_000]);
});
