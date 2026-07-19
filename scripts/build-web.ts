import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webSource = join(root, "apps", "web", "src");
const clientSource = join(root, "packages", "collab-client");
const outputRoot = join(root, "apps", "web", "dist");
const assetRoot = join(outputRoot, "assets");
const temporaryRoot = join(outputRoot, ".build");

function digest(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

async function buildEntrypoint(entrypoint: string, outdir: string, define?: Record<string, string>): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    ...(define === undefined ? {} : { define }),
    naming: "[name].[ext]",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `failed to build ${entrypoint}`);
  }
  return result.outputs.map(output => output.path);
}

async function moveHashedAsset(sourcePath: string, prefix: string): Promise<string> {
  const content = await readFile(sourcePath);
  const extension = extname(sourcePath);
  const filename = `${prefix}.${digest(content)}${extension}`;
  await rename(sourcePath, join(assetRoot, filename));
  return `/assets/${filename}`;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(assetRoot, { recursive: true });
await mkdir(temporaryRoot, { recursive: true });

const webBuild = await buildEntrypoint(join(webSource, "app.ts"), join(temporaryRoot, "web"));
const webScriptSource = webBuild.find(path => extname(path) === ".js");
if (webScriptSource === undefined) throw new Error("web build did not emit JavaScript");
const webScript = await moveHashedAsset(webScriptSource, "app");
const stylesheetSource = await readFile(join(webSource, "styles.css"));
const stylesheet = `/assets/app.${digest(stylesheetSource)}.css`;
await writeFile(join(outputRoot, stylesheet.slice(1)), stylesheetSource);

const clientBuild = await buildEntrypoint(
  join(clientSource, "upstream", "src", "main.tsx"),
  join(temporaryRoot, "client"),
);
let clientScript: string | undefined;
let clientStylesheet: string | undefined;
for (const output of clientBuild) {
  if (extname(output) === ".js") clientScript = await moveHashedAsset(output, "collab-client");
  if (extname(output) === ".css") clientStylesheet = await moveHashedAsset(output, "collab-client");
}
if (clientScript === undefined || clientStylesheet === undefined) {
  throw new Error("collab client build did not emit JavaScript and CSS");
}

const indexTemplate = await readFile(join(webSource, "index.html"), "utf8");
const indexHtml = indexTemplate
  .replace("<!--ASSET_STYLES-->", `<link rel="stylesheet" href="${stylesheet}" />`)
  .replace("<!--ASSET_SCRIPT-->", `<script type="module" src="${webScript}"></script>`);
await writeFile(join(outputRoot, "index.html"), indexHtml);

const clientTemplate = await readFile(join(clientSource, "src", "index.html"), "utf8");
const clientHtml = clientTemplate
  .replace("</head>", `    <link rel="stylesheet" href="${clientStylesheet}" />\n  </head>`)
  .replace("<!--CLIENT_SCRIPT-->", `<script type="module" src="${clientScript}"></script>`);
await mkdir(join(outputRoot, "client"), { recursive: true });
await writeFile(join(outputRoot, "client", "index.html"), clientHtml);

await copyFile(join(webSource, "manifest.webmanifest"), join(outputRoot, "manifest.webmanifest"));
await copyFile(join(webSource, "icon.svg"), join(outputRoot, "icon.svg"));
const shellAssets = [webScript, stylesheet];
const cacheName = `omp-sessions-shell-${digest(shellAssets.join("\0"))}`;
const workerBuild = await buildEntrypoint(join(webSource, "service-worker.ts"), join(temporaryRoot, "worker"), {
  __SHELL_ASSETS__: JSON.stringify(shellAssets),
  __CACHE_NAME__: JSON.stringify(cacheName),
});
const workerSource = workerBuild.find(path => basename(path) === "service-worker.js");
if (workerSource === undefined) throw new Error("service worker build did not emit JavaScript");
await rename(workerSource, join(outputRoot, "service-worker.js"));

await rm(temporaryRoot, { recursive: true, force: true });
console.log(`built PWA and pinned collab client (${webScript}, ${clientScript})`);
