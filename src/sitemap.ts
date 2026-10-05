import { get as getHttp } from "node:http";
import { get as getHttps } from "node:https";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { SitemapEntry } from "./types";

const gunzipAsync = promisify(gunzip);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
}

interface SitemapContents {
  entries: SitemapEntry[];
  childSitemaps: string[];
}

function request(url: URL, options: FetchOptions, redirects = 0): Promise<Buffer> {
  if (redirects > 5) {
    return Promise.reject(new Error(`Too many redirects while fetching ${url.href}`));
  }

  const get = url.protocol === "https:" ? getHttps : url.protocol === "http:" ? getHttp : null;
  if (!get) {
    return Promise.reject(new Error(`Unsupported sitemap URL protocol: ${url.protocol}`));
  }

  return new Promise((resolve, reject) => {
    const req = get(
      url,
      {
        headers: {
          "user-agent": "sitemap-monitor/1.0 (+https://github.com/element121/sitemap-monitor)"
        },
        timeout: options.timeoutMs
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (REDIRECT_STATUSES.has(status) && location) {
          response.resume();
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, url);
          } catch (error) {
            reject(new Error(`Invalid redirect from ${url.href}: ${String(error)}`));
            return;
          }
          request(nextUrl, options, redirects + 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`Request for ${url.href} returned HTTP ${status}`));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > options.maxBytes) {
            req.destroy(new Error(`Sitemap exceeds the ${options.maxBytes}-byte limit: ${url.href}`));
            return;
          }
          chunks.push(buffer);
        });
        response.on("error", reject);
        response.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );

    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms: ${url.href}`)));
    req.on("error", reject);
  });
}

async function fetchText(url: URL, options: FetchOptions): Promise<string> {
  const body = await request(url, options);
  let decoded = body;
  if (url.pathname.endsWith(".gz")) {
    try {
      decoded = await gunzipAsync(body);
    } catch (error) {
      throw new Error(`Could not decompress sitemap ${url.href}: ${String(error)}`);
    }
    if (decoded.length > options.maxBytes) {
      throw new Error(`Decompressed sitemap exceeds the ${options.maxBytes}-byte limit: ${url.href}`);
    }
  }
  return decoded.toString("utf8").replace(/^\uFEFF/, "");
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function tagValue(block: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`, "i"));
  return match ? decodeXml(match[1]) : undefined;
}

function parseSitemap(xml: string, sourceUrl: URL): SitemapContents {
  const root = xml.match(/<\s*(?:[\w.-]+:)?(urlset|sitemapindex)\b/i)?.[1]?.toLowerCase();
  if (!root) {
    throw new Error(`Unrecognized sitemap XML from ${sourceUrl.href}`);
  }

  if (root === "sitemapindex") {
    const childSitemaps: string[] = [];
    for (const match of xml.matchAll(/<(?:[\w.-]+:)?sitemap\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?sitemap\s*>/gi)) {
      const loc = tagValue(match[1], "loc");
      if (!loc) {
        throw new Error(`Sitemap index contains an entry without a <loc>: ${sourceUrl.href}`);
      }
      childSitemaps.push(new URL(loc, sourceUrl).href);
    }
    return { entries: [], childSitemaps };
  }

  const entries: SitemapEntry[] = [];
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?url\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?url\s*>/gi)) {
    const loc = tagValue(match[1], "loc");
    if (!loc) {
      throw new Error(`Sitemap contains a URL entry without a <loc>: ${sourceUrl.href}`);
    }
    const entry: SitemapEntry = { url: new URL(loc, sourceUrl).href };
    const lastmod = tagValue(match[1], "lastmod");
    const changefreq = tagValue(match[1], "changefreq");
    const priority = tagValue(match[1], "priority");
    if (lastmod) entry.lastmod = lastmod;
    if (changefreq) entry.changefreq = changefreq;
    if (priority) entry.priority = priority;
    entries.push(entry);
  }
  return { entries, childSitemaps: [] };
}

export async function readSitemapTree(
  sitemapUrl: string,
  options: FetchOptions
): Promise<SitemapEntry[]> {
  const visited = new Set<string>();
  const entries = new Map<string, SitemapEntry>();
  const pending = [new URL(sitemapUrl).href];

  while (pending.length > 0) {
    const currentUrl = pending.pop()!;
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    const sourceUrl = new URL(currentUrl);
    const contents = parseSitemap(await fetchText(sourceUrl, options), sourceUrl);
    for (const child of contents.childSitemaps) {
      if (!visited.has(child)) pending.push(child);
    }
    for (const entry of contents.entries) {
      entries.set(entry.url, entry);
    }
  }

  return [...entries.values()].sort((a, b) => a.url.localeCompare(b.url));
}
