export interface SiteConfig {
  name: string;
  sitemap: string;
}

export interface MonitorConfig {
  dataDir: string;
  requestTimeoutMs: number;
  maxSitemapBytes: number;
  sites: SiteConfig[];
}

export interface SitemapEntry {
  url: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
}

export interface Change {
  type: "added" | "modified" | "removed";
  url: string;
  previous?: SitemapEntry;
  current?: SitemapEntry;
}

export interface ChangeRecord {
  checkedAt: string;
  changes: Change[];
}

export interface SiteState {
  sitemap: string;
  checkedAt: string;
  entries: SitemapEntry[];
}
