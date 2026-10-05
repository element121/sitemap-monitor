import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Change, ChangeRecord, MonitorConfig, SiteConfig, SiteState, SitemapEntry } from "./types";
import { readSitemapTree } from "./sitemap";

function siteDirectoryName(site: SiteConfig): string {
  const slug = site.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
  let hash = 2166136261;
  for (const character of site.sitemap) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${slug}-${(hash >>> 0).toString(16)}`;
}

async function readPreviousState(path: string): Promise<SiteState | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as SiteState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read state file ${path}: ${String(error)}`);
  }
}

function compareEntries(previous: SitemapEntry[], current: SitemapEntry[]): Change[] {
  const oldEntries = new Map(previous.map((entry) => [entry.url, entry]));
  const newEntries = new Map(current.map((entry) => [entry.url, entry]));
  const changes: Change[] = [];

  for (const [url, entry] of newEntries) {
    const oldEntry = oldEntries.get(url);
    if (!oldEntry) {
      changes.push({ type: "added", url, current: entry });
    } else if (
      oldEntry.lastmod !== entry.lastmod ||
      oldEntry.changefreq !== entry.changefreq ||
      oldEntry.priority !== entry.priority
    ) {
      changes.push({ type: "modified", url, previous: oldEntry, current: entry });
    }
  }
  for (const [url, entry] of oldEntries) {
    if (!newEntries.has(url)) changes.push({ type: "removed", url, previous: entry });
  }

  return changes.sort((a, b) => a.url.localeCompare(b.url));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}

function renderChangelog(sites: Array<{ site: SiteConfig; records: ChangeRecord[] }>): string {
  const sections = sites.map(({ site, records }) => {
    const changes = records.flatMap((record) =>
      record.changes.map((change) => `
        <tr>
          <td>${escapeHtml(record.checkedAt)}</td>
          <td class="${change.type}">${change.type}</td>
          <td><a href="${escapeHtml(change.url)}">${escapeHtml(change.url)}</a></td>
          <td>${escapeHtml(change.previous?.lastmod ?? "—")}</td>
          <td>${escapeHtml(change.current?.lastmod ?? "—")}</td>
        </tr>`)
    ).join("");
    return `
      <section id="${escapeHtml(siteDirectoryName(site))}">
        <h2>${escapeHtml(site.name)}</h2>
        <p class="source">Sitemap: <a href="${escapeHtml(site.sitemap)}">${escapeHtml(site.sitemap)}</a></p>
        ${changes
          ? `<div class="table-wrap"><table><thead><tr><th>Checked (UTC)</th><th>Change</th><th>URL</th><th>Previous lastmod</th><th>Current lastmod</th></tr></thead><tbody>${changes}</tbody></table></div>`
          : "<p>No changes recorded yet.</p>"}
      </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sitemap Monitor Changelog</title>
  <style>
    :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
    body { max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
    h1 { margin-bottom: .25rem; } .source { overflow-wrap: anywhere; color: #777; }
    section { margin: 2rem 0; } .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid #8885; padding: .6rem; text-align: left; }
    td a { overflow-wrap: anywhere; } .added { color: #188038; } .modified { color: #b06000; } .removed { color: #c5221f; }
    @media (prefers-color-scheme: dark) { .added { color: #81c995; } .modified { color: #fdd663; } .removed { color: #f28b82; } }
  </style>
</head>
<body>
  <h1>Sitemap Monitor Changelog</h1>
  <p>Changes are detected by comparing sitemap URLs and their lastmod, changefreq, and priority values.</p>
  ${sections || "<p>No sites configured.</p>"}
</body>
</html>
`;
}

async function readChangeRecords(path: string): Promise<ChangeRecord[]> {
  try {
    const content = await readFile(path, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ChangeRecord).reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Could not read changelog ${path}: ${String(error)}`);
  }
}

export async function monitorSite(config: MonitorConfig, site: SiteConfig): Promise<ChangeRecord> {
  const directory = join(config.dataDir, "sites", siteDirectoryName(site));
  const snapshotsDirectory = join(directory, "snapshots");
  await mkdir(snapshotsDirectory, { recursive: true });

  const statePath = join(directory, "current.json");
  const changelogPath = join(directory, "changes.jsonl");
  const previous = await readPreviousState(statePath);
  const entries = await readSitemapTree(site.sitemap, {
    timeoutMs: config.requestTimeoutMs,
    maxBytes: config.maxSitemapBytes
  });
  const checkedAt = new Date().toISOString();
  const changes = previous ? compareEntries(previous.entries, entries) : [];
  const record: ChangeRecord = { checkedAt, changes };
  const state: SiteState = { sitemap: site.sitemap, checkedAt, entries };

  const date = checkedAt.slice(0, 10);
  await writeFile(join(snapshotsDirectory, `${date}.json`), `${JSON.stringify(state, null, 2)}\n`);
  if (changes.length > 0) {
    await appendFile(changelogPath, `${JSON.stringify(record)}\n`);
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  return record;
}

export async function updateChangelogPage(config: MonitorConfig): Promise<string> {
  const sites = await Promise.all(config.sites.map(async (site) => {
    const directory = join(config.dataDir, "sites", siteDirectoryName(site));
    const records = await readChangeRecords(join(directory, "changes.jsonl"));
    return { site, records };
  }));
  const path = join(config.dataDir, "changelog.html");
  await writeFile(path, renderChangelog(sites));
  return path;
}

export async function showChangelog(config: MonitorConfig, siteName?: string): Promise<void> {
  const sites = siteName
    ? config.sites.filter((site) => site.name.toLowerCase() === siteName.toLowerCase())
    : config.sites;
  if (siteName && sites.length === 0) {
    throw new Error(`No configured site named "${siteName}".`);
  }

  for (const site of sites) {
    const directory = join(config.dataDir, "sites", siteDirectoryName(site));
    const records = await readChangeRecords(join(directory, "changes.jsonl"));
    console.log(`\n${site.name} — ${site.sitemap}`);
    if (records.length === 0) {
      console.log("  No changes recorded yet.");
      continue;
    }
    for (const record of records) {
      console.log(`\n  ${record.checkedAt}`);
      for (const change of record.changes) {
        console.log(`  ${change.type.padEnd(8)} ${change.url}`);
        if (change.type === "modified") {
          console.log(`           lastmod: ${change.previous?.lastmod ?? "—"} -> ${change.current?.lastmod ?? "—"}`);
        }
      }
    }
  }
}
