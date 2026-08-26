# Plan — an OS tiles proxy for BNG, shared by the web map and the PDF

Written after reading how other Defra services do this. The short version:
**copy NRF's architecture, not its tile product or its projection.**

## What the other services do

### `DEFRA/nrf-frontend` — `src/server/os-base-map/routes.js`

A catch-all proxy, `/os-base-map/{path*}` → `https://api.os.uk/maps/vector/v1/vts`,
forcing `srs=3857`. The parts worth copying:

- API key lives in config (`map.osApiKey`, `sensitive: true`, env `OS_API_KEY`)
  and **never reaches the browser**.
- JSON style responses are walked with a `JSON.parse` reviver that rewrites
  every `api.os.uk` URL to a proxy URL **and strips the query string**. That is
  what stops the key leaking through the style document — the non-obvious bit,
  because a style file is full of absolute URLs.
- Binary `.pbf`/`.png`/`.jpg` passed straight through, unparsed.
- Uses `fetch`/undici *deliberately*, so requests route through the CDP
  `HTTP_PROXY` set up by `setGlobalDispatcher` in `setup-proxy.js` — the
  identical helper `bng-metric-frontend` already has.
- `src/server/common/services/tile-cache.js`: Redis, TTL from config,
  ElastiCache-safe `SCAN` rather than `KEYS`, cluster fan-out by master node.

NRF has **no PDF export**, so there is no precedent there to borrow.

### `DEFRA/grants-ui` — `/api/map/os-tiles/{z}/{x}/{y}`

Closer to what we need, because it is raster:

- Proxies `https://api.os.uk/maps/raster/v1/zxy` — the OS **Maps API**.
- `OS_MAPS_API_KEY`, sensitive, server-side only, a **CDP secret per
  environment** (explicitly *not* `cdp-app-config`).
- Rewrites the style so `sources['os-raster'].tiles` points at the proxy.
- `tile-params.js` validates z/x/y against `2^z` — an abuse guard.
- A dedicated log code fires when the key is unset, because the failure is
  otherwise an undiagnosable 401.
- Their `docs/MAPS.md` states they deliberately avoid the OS Vector Tile API.
  They give a 2028 retirement as the reason; **that date is unverified against
  OS's own documentation** — OS publishes end-of-life dates for individual
  datasets within that API, not for the API itself. Do not repeat the date as
  fact. It does not change this plan either way.

## Why we should not copy NRF's tile choice

| | NRF | What BNG's PDF needs |
| --- | --- | --- |
| Format | Vector `.pbf` (MVT) | **Raster PNG** — pdfkit embeds it directly. MVT needs a GL renderer, which is the maplibre-native / Alpine-musl problem again |
| CRS | `srs=3857` Web Mercator | **EPSG:27700** — our geometry is British National Grid. 3857 reintroduces reprojection and destroys the plain affine transform the whole PDF map rests on |
| Product | OS Vector Tile API | OS Maps API (raster). Our own prototype already uses OS NGD Tiles, the newer vector product |

Both differences are load-bearing, not stylistic. Matching NRF here would make
the PDF materially harder to build.

## The plan

Build one proxy that both the browser map and the PDF generator fetch tiles
through. Nothing else in the system holds an OS key.

```
browser map ─┐
             ├─→  /os-tiles/{z}/{x}/{y}  ─→  cache  ─→  api.os.uk (via CDP proxy)
PDF builder ─┘         (key injected here, once)
```

**Take from NRF:** route shape, server-side key injection, style-URL
rewriting, `fetch`/undici for CDP proxy traversal, the Redis tile cache.

**Take from grants-ui:** the raster ZXY upstream, `z`/`x`/`y` bounds
validation, and the explicit "key is not set" diagnostic.

**Do differently:** stay in EPSG:27700, and serve raster. If the web map later
wants vector, add an NGD Tiles route to the *same* proxy rather than a second
service.

### Why this beats what the spike does today

`src/tiles.mjs`'s `osTileSource` currently calls `api.os.uk` directly. On CDP
that is wrong three times over: it will not traverse the platform egress proxy
without extra wiring, it puts API-key handling inside the PDF builder, and it
gets no caching. Pointing it at an internal route fixes all three — **the PDF
generator then needs no API key at all, only a URL.**

The cache matters more for PDFs than for browsers. A browser user pans once and
the browser caches; a PDF re-fetches the same site's tiles on every download.
One site map is ~30 tiles; with `--habitat-basemap` the spike fetched 112.

## Scope of this spike

Raster EPSG:27700 only — the smallest thing that proves the plan. Written as a
**portable Hapi plugin inside the spike**, with no assumption about which
sibling adopts it.

### Where it should eventually live — for the team to settle

- **Frontend.** Already has `setup-proxy.js`, `ioredis`/`catbox-redis`, and
  serves the summary page. Matches where NRF and grants-ui put theirs.
- **Backend.** Owns the PostGIS geometry, so if PDF generation lands there,
  both geometry and tiles are local with no cross-service hop.

This depends on where PDF generation runs, which is not yet decided, so the
plugin is written to be mounted by either.

## OS Data Hub key

Keys are **project-scoped**: create an API Project, then "+ Add API" per
product. A key missing the product returns a bare 401.

- **OS Maps API** — required. Raster ZXY tiles *and* the WMTS
  `GetCapabilities` document that carries the authoritative EPSG:27700 tile
  matrix (origin, resolutions). That grid must never be hard-coded.
- **OS NGD API – Tiles** — only if the browser vector basemap is wanted later.
- OS Vector Tile API, OS Names API, OS Places API — not needed.

The free OS OpenData plan includes OS Maps API. Defra is a PSGA member, so
check for an existing departmental project before creating a new key.

## Open questions for the team

1. Does OS licensing permit **embedding** a basemap in a downloadable PDF?
   That is a different question from displaying it in a browser, because a PDF
   is redistributable. Ask OS directly.
2. Attribution must be burned into the page — a PDF cannot carry a dynamic
   control. Confirm the required wording.
3. Frontend or backend, per above.
