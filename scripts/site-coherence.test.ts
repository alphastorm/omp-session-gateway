import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const rootPath = new URL("../", import.meta.url).pathname;
const sitePath = join(rootPath, "site");
const siteOrigin = "https://alphastorm.github.io/omp-session-gateway/";

/**
 * Assets the Pages workflow copies into `site/` at deploy time so the site never carries a
 * second copy of a brand or media file. Keys are site-relative names, values their canonical
 * sources; `.github/workflows/pages.yml` and the `site/` block in `.gitignore` list the same set.
 */
const STAGED_SITE_ASSETS: Record<string, string> = {
  "logo.svg": "assets/logo.svg",
  "favicon.svg": "apps/web/src/favicon.svg",
  "og.png": "assets/og.png",
  "product-flow.png": "docs/media/omp-session-gateway-product-flow.png",
};

async function sitePages(): Promise<Array<{ path: string; url: string }>> {
  const out: Array<{ path: string; url: string }> = [];
  for (const entry of await readdir(sitePath, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name !== "index.html") continue;
    const dir = relative(sitePath, entry.parentPath);
    out.push({ path: join(entry.parentPath, entry.name), url: dir === "" ? siteOrigin : `${siteOrigin}${dir}/` });
  }
  return out.sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * The public site states the qualified release and OMP baseline. The README once advertised a
 * stale version for a whole release cycle; these pages are read by people who never open the
 * repository, so a release cut that forgets them must fail `bun run check`, not go live.
 */
test("public site claims the qualified release and OMP baseline from the locks", async () => {
  const stable = JSON.parse(await readFile(join(rootPath, "STABLE_RELEASE.lock.json"), "utf8")) as {
    releaseTag: string;
    candidateTag: string;
    previousTag: string;
  };
  const upstream = JSON.parse(await readFile(join(rootPath, "UPSTREAM.lock.json"), "utf8")) as { tag: string };
  const claims: Record<string, string[]> = {
    "site/index.html": [stable.releaseTag, upstream.tag],
    "site/status/index.html": [stable.releaseTag, stable.candidateTag, stable.previousTag, upstream.tag],
    "site/llms.txt": [stable.releaseTag, upstream.tag],
  };
  for (const [rel, expected] of Object.entries(claims)) {
    const text = await readFile(join(rootPath, rel), "utf8");
    for (const claim of expected) expect(text, `${rel} must state ${claim}`).toContain(claim);
  }
});

test("every relative asset a site page references exists after staging", async () => {
  const workflow = await readFile(join(rootPath, ".github/workflows/pages.yml"), "utf8");
  for (const [name, source] of Object.entries(STAGED_SITE_ASSETS)) {
    expect(await Bun.file(join(rootPath, source)).exists(), `${source} is the canonical source of site/${name}`).toBe(true);
    expect(workflow, `pages.yml must stage ${source}`).toContain(source);
  }
  for (const page of await sitePages()) {
    const html = await readFile(page.path, "utf8");
    for (const match of html.matchAll(/\b(?:src|href)="([^"#]+)"/g)) {
      const target = match[1] ?? "";
      if (/^(?:https?:)?\/\//.test(target) || target === "") continue;
      const resolved = join(dirname(page.path), target);
      const committed = await Bun.file(target.endsWith("/") ? join(resolved, "index.html") : resolved).exists();
      const staged = Object.hasOwn(STAGED_SITE_ASSETS, relative(sitePath, resolved));
      expect(committed || staged, `${relative(rootPath, page.path)} references missing ${target}`).toBe(true);
    }
  }
});

test("sitemap and canonical links name exactly the site pages under the canonical origin", async () => {
  const pages = await sitePages();
  const sitemap = await readFile(join(sitePath, "sitemap.xml"), "utf8");
  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc).sort();
  expect(listed).toEqual(pages.map(page => page.url));
  for (const page of pages) {
    const html = await readFile(page.path, "utf8");
    expect(html, `${relative(rootPath, page.path)} canonical URL`).toContain(`<link rel="canonical" href="${page.url}">`);
  }
});
