#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { defaultGatewayPaths } from "./config.ts";

interface PublisherState {
  readonly index: number;
  readonly instanceId: string;
  readonly viewLink: string;
  readonly controlLink: string;
  authenticated: boolean;
  buffer: string;
}

const countArgument = process.argv[2] ?? "3";
if (!/^\d+$/u.test(countArgument) || Number(countArgument) < 1 || Number(countArgument) > 50) {
  throw new Error("synthetic publisher count must be from 1 to 50");
}
const count = Number(countArgument);
const paths = defaultGatewayPaths();
const token = (await readFile(paths.tokenPath, "utf8")).trim();
const sockets: Bun.Socket<PublisherState>[] = [];
let ready = 0;

for (let index = 0; index < count; index += 1) {
  const suffix = randomBytes(12).toString("base64url");
  const instanceId = `synthetic-instance-${index.toString().padStart(3, "0")}-${suffix}`;
  const socket = await Bun.connect<PublisherState>({
    unix: paths.socketPath,
    socket: {
      open(connection) {
        connection.write(`${JSON.stringify({ v: 1, op: "hello", token, instanceId, pid: process.pid })}\n`);
      },
      data(connection, chunk) {
        connection.data.buffer += Buffer.from(chunk).toString("utf8");
        if (!connection.data.authenticated && connection.data.buffer.includes("\n")) {
          const lineEnd = connection.data.buffer.indexOf("\n");
          const response = JSON.parse(connection.data.buffer.slice(0, lineEnd)) as Record<string, unknown>;
          connection.data.buffer = connection.data.buffer.slice(lineEnd + 1);
          if (response.op !== "hello_ok") throw new Error("gateway rejected synthetic publisher");
          connection.data.authenticated = true;
          connection.write(
            `${JSON.stringify({
              v: 1,
              op: "upsert",
              session: {
                instanceId: connection.data.instanceId,
                generation: 1,
                pid: process.pid,
                sessionId: `synthetic-session-${connection.data.index}`,
                title: `Synthetic OMP session ${connection.data.index + 1}`,
                cwdLabel: `fixture-${connection.data.index + 1}`,
                model: "fixture/model",
                startedAt: new Date(Date.now() - connection.data.index * 60_000).toISOString(),
                viewLink: connection.data.viewLink,
                controlLink: connection.data.controlLink,
              },
            })}\n`,
          );
          ready += 1;
          if (ready === count) console.log(`published ${count} synthetic sessions`);
        }
      },
      close() {},
      error() {
        process.exitCode = 1;
      },
    },
    data: {
      index,
      instanceId,
      viewLink: ["SYNTHETIC", "VIEW", suffix, "VALUE"].join("__"),
      controlLink: ["SYNTHETIC", "CONTROL", suffix, "VALUE"].join("__"),
      authenticated: false,
      buffer: "",
    },
  });
  sockets.push(socket);
}

const heartbeat = setInterval(() => {
  for (const socket of sockets) {
    if (!socket.data.authenticated) continue;
    socket.write(
      `${JSON.stringify({
        v: 1,
        op: "heartbeat",
        instanceId: socket.data.instanceId,
        generation: 1,
        observedAt: new Date().toISOString(),
      })}\n`,
    );
  }
}, 10_000);

await new Promise<void>(resolve => {
  const stop = (): void => resolve();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
clearInterval(heartbeat);
for (const socket of sockets) {
  if (socket.data.authenticated) {
    socket.write(
      `${JSON.stringify({ v: 1, op: "remove", instanceId: socket.data.instanceId, generation: 1, reason: "shutdown" })}\n`,
    );
  }
  socket.end();
}
