# sitemap-monitor

A Node.js and TypeScript CLI that tracks additions, modifications, and removals in one or more websites' XML sitemaps. Sitemap files are fetched with Node's built-in HTTP/HTTPS modules; no runtime dependencies are required.

## Requirements

- Node.js 18 or newer
- npm

## Quick start

```sh
npm install
npm run build
cp config.example.json config.json
# Edit config.json with your websites and sitemap URLs.
npm run monitor
```

Schedule `npm run monitor` to run daily with cron, a system scheduler, or CI. Each configured site is monitored independently; a failure for one site is reported and does not prevent the others from being checked.

## Configuration

`config.json` is read from the current directory by default. Pass another path with `--config`:

```json
{
  "dataDir": "./data",
  "requestTimeoutMs": 20000,
  "maxSitemapBytes": 52428800,
  "sites": [
    {
      "name": "Example website",
      "sitemap": "https://example.com/sitemap.xml"
    }
  ]
}
```

- `sites` is required and must contain at least one `{ "name", "sitemap" }` entry.
- `dataDir` defaults to `./data`.
- `requestTimeoutMs` defaults to 20 seconds per request.
- `maxSitemapBytes` defaults to 50 MiB per sitemap file (also applied after gzip decompression).
- HTTP and HTTPS sitemap URLs are supported. Redirects, gzip-compressed `.xml.gz` files, sitemap indexes, and namespaced XML tags are supported. Sitemap index children are followed recursively, with duplicate sitemap URLs and page URLs ignored.

## Commands

```sh
npm run monitor
npm run monitor -- --config ./config.json
npm run monitor -- "Example website"
npm run changelog
npm run changelog -- "Example website"
npm run changelog -- --config ./config.json
```

`run` compares each sitemap with its previous successful run and stores the current state, a daily snapshot, and any detected changes. The first successful run establishes a baseline and reports zero changes. A change to a URL's `lastmod`, `changefreq`, or `priority` is recorded as a modification. Page-content changes that are not reflected in sitemap metadata cannot be detected.

`changelog` prints recorded changes in the terminal and refreshes `data/changelog.html`, a standalone page that can be opened in a browser. Data is stored under `data/sites/`; back up that directory to preserve monitoring history. Daily snapshots use the UTC date and are updated if the monitor runs more than once on the same day; the event changelog retains each run that found changes.

## How modification detection works

Sitemaps describe URLs and optional metadata; they do not contain page contents. Added and removed URLs can always be identified by comparing snapshots. Modifications are identified by comparing the sitemap's `lastmod`, `changefreq`, and `priority` values for URLs present in both snapshots. To detect actual page-content changes, a separate page-fetching and content-hashing feature would be needed.

## License

MIT
