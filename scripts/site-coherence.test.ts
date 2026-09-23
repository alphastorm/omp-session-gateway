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

// A prose mention of the new version must not conceal a stale installation/download action.
test("getting-started and site download actions select the qualified stable release", async () => {
  const stable = JSON.parse(await readFile(join(rootPath, "STABLE_RELEASE.lock.json"), "utf8")) as {
    releaseTag: string;
  };
  const releaseBase = "https://github.com/alphastorm/omp-session-gateway/releases/tag/";
  const expected = `${releaseBase}${stable.releaseTag}`;
  const readme = await readFile(join(rootPath, "README.md"), "utf8");
  const gettingStarted = readme.split("## Build and run\n")[1]?.split("\n## ")[0];
  const firstRelease = gettingStarted?.match(/\]\((https:\/\/github\.com\/alphastorm\/omp-session-gateway\/releases\/tag\/[^)]+)\)/u)?.[1];
  expect(firstRelease, "the installation guide must start with the stable artifact").toBe(expected);

  const downloads: string[] = [];
  const html = await readFile(join(sitePath, "index.html"), "utf8");
  await new HTMLRewriter().on("a.cta", {
    element(element) {
      const href = element.getAttribute("href");
      if (href?.startsWith(releaseBase)) downloads.push(href);
    },
  }).transform(new Response(html)).text();
  expect(downloads).toEqual([expected]);
});

// Promotion flipped the download links while the install and verification commands kept naming
// 0.4.x archives through two later stable releases, and rollback guidance kept an older pair.
test("install, verification, and predecessor guidance follow the stable lock", async () => {
  const stable = JSON.parse(await readFile(join(rootPath, "STABLE_RELEASE.lock.json"), "utf8")) as {
    version: string;
    releaseTag: string;
    previousTag: string;
  };
  const section = async (file: string, heading: string): Promise<string> => {
    const text = (await readFile(join(rootPath, file), "utf8")).split(`\n${heading}\n`)[1]?.split("\n## ")[0];
    if (text === undefined) throw new Error(`${file} lost its "${heading}" section`);
    return text;
  };
  const artifacts = (text: string) => [...new Set(text.match(/omp-session-gateway-\d+\.\d+\.\d+/gu))];
  const current = [`omp-session-gateway-${stable.version}`];
  expect(artifacts(await section("README.md", "## Build and run"))).toEqual(current);
  expect(artifacts(await section("docs/OPERATIONS.md", "## 2. CLI and daemon installation"))).toEqual(current);
  const verification = await section("docs/RELEASE.md", "## Verify a published build");
  expect(artifacts(verification)).toEqual(current);
  expect(verification.match(/^TAG=(\S+)$/mu)?.[1]).toBe(stable.releaseTag);
  const rollback = await readFile(join(rootPath, "docs/UPGRADE_ROLLBACK.md"), "utf8");
  expect(rollback).toContain(`\n## ${stable.releaseTag} predecessor compatibility\n`);
  expect(rollback).toContain(`The selected predecessor is published ${stable.previousTag}.`);
});

// The machine-readable summary stayed on v0.4.0 through three later stable releases. Promotion
// commits the lock before the signed workflow publishes, so the summary states either phase.
test("the machine-readable site summary names only the qualified stable release", async () => {
  const stable = JSON.parse(await readFile(join(rootPath, "STABLE_RELEASE.lock.json"), "utf8")) as {
    releaseTag: string;
  };
  const summary = (await readFile(join(sitePath, "llms.txt"), "utf8")).split("\n## ")[0] ?? "";
  const phases = [
    `Stable ${stable.releaseTag} is published as immutable`,
    `${stable.releaseTag} is qualified for stable promotion; publication is pending`,
  ];
  expect(phases.filter(phase => summary.includes(phase))).toHaveLength(1);
  expect([...new Set(summary.match(/\bv\d+\.\d+\.\d+\b/gu))]).toEqual([stable.releaseTag]);
});

test("every relative asset a site page references exists after staging", async () => {
  for (const [name, source] of Object.entries(STAGED_SITE_ASSETS)) {
    expect(await Bun.file(join(rootPath, source)).exists(), `${source} is the canonical source of site/${name}`).toBe(true);
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
    const canonical: string[] = [];
    await new HTMLRewriter().on('link[rel~="canonical"]', {
      element(element) {
        canonical.push(element.getAttribute("href") ?? "");
      },
    }).transform(new Response(html)).text();
    expect(canonical, `${relative(rootPath, page.path)} canonical URL`).toEqual([page.url]);
  }
});
