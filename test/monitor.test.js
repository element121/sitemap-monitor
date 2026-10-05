const assert = require("node:assert/strict");
const { mkdtemp, readFile, readdir, rm } = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { monitorSite, updateChangelogPage } = require("../dist/monitor");

let server;
let baseUrl;
let dataDir;
let sitemapXml;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "sitemap-monitor-test-"));
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/xml");
    if (req.url === "/index.xml") {
      res.end(`<?xml version="1.0"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>${baseUrl}/pages.xml</loc></sitemap>
          <sitemap><loc>${baseUrl}/pages.xml</loc></sitemap>
        </sitemapindex>`);
      return;
    }
    if (req.url === "/pages.xml") {
      res.end(sitemapXml);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

function sitemap(entries) {
  return `<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      ${entries.map(({ url, lastmod }) => `<url><loc>${url}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("")}
    </urlset>`;
}

test("follows sitemap indexes and records added, modified, and removed URLs", async () => {
  const config = {
    dataDir,
    requestTimeoutMs: 5000,
    maxSitemapBytes: 1024 * 1024,
    sites: [{ name: "Test site", sitemap: `${baseUrl}/index.xml` }]
  };
  const site = config.sites[0];

  sitemapXml = sitemap([
    { url: `${baseUrl}/existing`, lastmod: "2026-01-01" },
    { url: `${baseUrl}/removed`, lastmod: "2026-01-02" }
  ]);
  const baseline = await monitorSite(config, site);
  assert.deepEqual(baseline.changes, []);

  sitemapXml = sitemap([
    { url: `${baseUrl}/existing`, lastmod: "2026-02-01" },
    { url: `${baseUrl}/added`, lastmod: "2026-02-02" }
  ]);
  const nextRun = await monitorSite(config, site);
  assert.deepEqual(nextRun.changes.map(({ type, url }) => ({ type, url })), [
    { type: "added", url: `${baseUrl}/added` },
    { type: "modified", url: `${baseUrl}/existing` },
    { type: "removed", url: `${baseUrl}/removed` }
  ]);

  const htmlPath = await updateChangelogPage(config);
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /added/);
  assert.match(html, /modified/);
  assert.match(html, /removed/);
  assert.equal((await readdir(path.join(dataDir, "sites", (await readdir(path.join(dataDir, "sites")))[0], "snapshots"))).length, 1);
});
