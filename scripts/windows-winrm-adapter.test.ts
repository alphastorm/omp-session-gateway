import { expect, test } from "bun:test";
import { join } from "node:path";

// The WinRM adapter is Python, so its standard-library suite (fake transport, no pywinrm or network)
// runs from here to join every `bun test` instead of depending on someone running it by hand.
test("the WinRM adapter's standard-library suite passes", async () => {
  const interpreter = process.platform === "win32" ? "python" : "python3";
  const child = Bun.spawn([interpreter, join(import.meta.dir, "windows-winrm.test.py")], { stdout: "pipe", stderr: "pipe" });
  const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, summary: stderr.trim().split(/\r?\n/u).at(-1) }).toEqual({ code: 0, summary: "OK" });
});
