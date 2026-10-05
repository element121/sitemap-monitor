import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MonitorConfig } from "./types";
import { monitorSite, showChangelog, updateChangelogPage } from "./monitor";

function usage(): never {
  console.error("Usage: sitemap-monitor <run|changelog> [site name] [--config path]");
  process.exit(2);
}

async function loadConfig(path: string): Promise<MonitorConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not load config at ${path}: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Config must be a JSON object.");

  const value = parsed as Partial<MonitorConfig>;
  if (!Array.isArray(value.sites) || value.sites.length === 0) {
    throw new Error("Config must contain a non-empty sites array.");
  }
  for (const [index, site] of value.sites.entries()) {
    if (!site || typeof site.name !== "string" || !site.name.trim() ||
      typeof site.sitemap !== "string" || !site.sitemap.trim()) {
      throw new Error(`Site at index ${index} must have a non-empty name and sitemap URL.`);
    }
    let url: URL;
    try {
      url = new URL(site.sitemap);
    } catch {
      throw new Error(`Invalid sitemap URL for "${site.name}": ${site.sitemap}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`Sitemap URL for "${site.name}" must use HTTP or HTTPS.`);
    }
  }
  const requestTimeoutMs = value.requestTimeoutMs ?? 20000;
  const maxSitemapBytes = value.maxSitemapBytes ?? 50 * 1024 * 1024;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("requestTimeoutMs must be a positive integer.");
  }
  if (!Number.isInteger(maxSitemapBytes) || maxSitemapBytes <= 0) {
    throw new Error("maxSitemapBytes must be a positive integer.");
  }
  if (value.dataDir !== undefined && (typeof value.dataDir !== "string" || !value.dataDir.trim())) {
    throw new Error("dataDir must be a non-empty path.");
  }

  return {
    dataDir: resolve(value.dataDir ?? "./data"),
    requestTimeoutMs,
    maxSitemapBytes,
    sites: value.sites
  };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "run" && command !== "changelog") usage();

  let configPath = "config.json";
  let siteName: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--config") {
      configPath = args[++index] ?? usage();
    } else if (args[index].startsWith("--")) {
      usage();
    } else if (!siteName) {
      siteName = args[index];
    } else {
      usage();
    }
  }

  const config = await loadConfig(resolve(configPath));
  if (command === "changelog") {
    await showChangelog(config, siteName);
    const path = await updateChangelogPage(config);
    console.log(`\nHTML changelog: ${path}`);
    return;
  }

  const sites = siteName
    ? config.sites.filter((site) => site.name.toLowerCase() === siteName!.toLowerCase())
    : config.sites;
  if (siteName && sites.length === 0) throw new Error(`No configured site named "${siteName}".`);

  let failed = false;
  for (const site of sites) {
    try {
      const record = await monitorSite(config, site);
      const count = record.changes.length;
      console.log(`${site.name}: ${count} change${count === 1 ? "" : "s"} detected.`);
    } catch (error) {
      failed = true;
      console.error(`${site.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const path = await updateChangelogPage(config);
  console.log(`HTML changelog: ${path}`);
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
