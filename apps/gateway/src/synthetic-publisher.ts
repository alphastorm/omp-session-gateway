#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseChallengeFrame, parseHelloOkFrame, parseJsonFrame } from "@omp-session-gateway/protocol";
import {
  createRegistryAuthNonce,
  createRegistryClientProof,
  createRegistryServerProof,
  registryAuthProofMatches,
  type RegistryAuthBinding,
} from "@omp-session-gateway/protocol/ipc-auth";
import { defaultGatewayPaths } from "./config.ts";

interface PublisherState {
  readonly index: number;
  readonly instanceId: string;
  readonly viewLink: string;
  readonly controlLink: string;
  readonly clientNonce: string;
  challengeAccepted: boolean;
  authenticated: boolean;
  buffer: string;
}

const countArgument = process.argv[2] ?? "3";
if (!/^\d+$/u.test(countArgument) || Number(countArgument) < 1 || Number(countArgument) > 50) {
  throw new Error("synthetic publisher count must be from 1 to 50");
}
const count = Number(countArgument);
const paths = defaultGatewayPaths();
let token = (await readFile(paths.tokenPath, "utf8")).trim();
const sockets: Bun.Socket<PublisherState>[] = [];
let ready = 0;

for (let index = 0; index < count; index += 1) {
  const suffix = randomBytes(12).toString("base64url");
  const instanceId = `synthetic-instance-${index.toString().padStart(3, "0")}-${suffix}`;
  const socket = await Bun.connect<PublisherState>({
    unix: paths.socketPath,
    socket: {
      open(connection) {
        connection.write(
          `${JSON.stringify({
            v: 1,
            op: "hello",
            clientNonce: connection.data.clientNonce,
            instanceId,
            pid: process.pid,
          })}\n`,
        );
      },
      data(connection, chunk) {
        connection.data.buffer += Buffer.from(chunk).toString("utf8");
        if (Buffer.byteLength(connection.data.buffer, "utf8") > 1_024) {
          connection.end();
          throw new Error("gateway returned an oversized synthetic publisher handshake");
        }
        while (!connection.data.authenticated && connection.data.buffer.includes("\n")) {
          const lineEnd = connection.data.buffer.indexOf("\n");
          const value = parseJsonFrame(new TextEncoder().encode(connection.data.buffer.slice(0, lineEnd)));
          connection.data.buffer = connection.data.buffer.slice(lineEnd + 1);
          if (!connection.data.challengeAccepted) {
            const challenge = parseChallengeFrame(value);
            const binding: RegistryAuthBinding = {
              clientNonce: connection.data.clientNonce,
              serverNonce: challenge.serverNonce,
              instanceId: connection.data.instanceId,
              pid: process.pid,
            };
            if (!registryAuthProofMatches(createRegistryServerProof(token, binding), challenge.proof)) {
              connection.end();
              throw new Error("gateway server authentication failed");
            }
            connection.write(
              `${JSON.stringify({
                v: 1,
                op: "authenticate",
                proof: createRegistryClientProof(token, binding),
              })}\n`,
            );
            connection.data.challengeAccepted = true;
            continue;
          }

          parseHelloOkFrame(value);
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
                inputRequired: false,
                viewLink: connection.data.viewLink,
                controlLink: connection.data.controlLink,
              },
            })}\n`,
          );
          ready += 1;
          if (ready === count) {
            token = "";
            console.log(`published ${count} synthetic sessions`);
          }
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
      clientNonce: createRegistryAuthNonce(),
      challengeAccepted: false,
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
