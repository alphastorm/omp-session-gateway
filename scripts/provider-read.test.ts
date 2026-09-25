import { expect, test } from "bun:test";
import { readProvider } from "./provider-read.ts";

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

test("a persistent 5xx reaches the caller after three reads, without a final sleep", async () => {
  const provider = replies([502, 502, 502, 200]);
  const delays: number[] = [];
  const response = await readProvider(provider.read, { sleep: async milliseconds => void delays.push(milliseconds) });
  expect(response.status).toBe(502);
  expect(provider.reads()).toBe(3);
  expect(delays).toEqual([2_000, 4_000]);
});

test("a client error or a missing object is final at once", async () => {
  for (const status of [404, 401, 429]) {
    const provider = replies([status, 200]);
    const delays: number[] = [];
    expect((await readProvider(provider.read, { sleep: async milliseconds => void delays.push(milliseconds) })).status).toBe(status);
    expect([provider.reads(), delays.length]).toEqual([1, 0]);
  }
});
