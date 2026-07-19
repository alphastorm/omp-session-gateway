import { readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

interface StaticAsset {
  readonly filePath: string;
  readonly contentType: string;
  readonly immutable: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

export class StaticAssetStore {
  readonly #root: string;
  readonly #assets = new Map<string, StaticAsset>();

  private constructor(root: string) {
    this.#root = root;
  }

  static async load(root: string): Promise<StaticAssetStore> {
    const resolvedRoot = await realpath(root);
    const rootInfo = await stat(resolvedRoot);
    if (!rootInfo.isDirectory()) throw new Error("static asset root is not a directory");
    const store = new StaticAssetStore(resolvedRoot);
    await store.#walk(resolvedRoot);
    if (!store.#assets.has("/index.html")) throw new Error("static asset root is missing index.html");
    return store;
  }

  response(pathname: string): Response | undefined {
    const requestedPath = pathname === "/" ? "/index.html" : pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const asset = this.#assets.get(requestedPath);
    if (asset === undefined) return undefined;
    return new Response(Bun.file(asset.filePath), {
      headers: {
        "Content-Type": asset.contentType,
        "Cache-Control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  }

  async #walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("static assets may not contain symlinks");
      if (entry.isDirectory()) {
        await this.#walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(this.#root, fullPath);
      if (relativePath.startsWith(`..${sep}`) || relativePath === "..") throw new Error("static path escaped root");
      const urlPath = `/${relativePath.split(sep).join("/")}`;
      const extension = extname(entry.name).toLowerCase();
      this.#assets.set(urlPath, {
        filePath: fullPath,
        contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
        immutable: /^\/assets\/[a-z0-9-]+\.[a-f0-9]{12}\.[a-z0-9]+$/u.test(urlPath),
      });
    }
  }
}
