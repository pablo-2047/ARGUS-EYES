# ARGUS EYES

A fast, zero-dependency, self-hosted global public CCTV, traffic camera, and live OSINT map running locally on your machine (`localhost:8080`).

Built with **Node.js (standard library only)**, **MapLibre GL JS**, and **HLS.js**, **ARGUS EYES** aggregates **28,500+ public cameras out of the box (no API keys required)** — with optional free API key integrations to scale past **100,000+ cameras** alongside real-time aircraft, ship, earthquake, natural event, and weather radar layers.

---

## Features

- **Zero-Dependency Backend**: Pure Node.js (`>= 18`), no `npm install` required. Starts in seconds.
- **28,500+ Live Cameras Out of the Box**: Aggregates 26+ official government DOT, transport, and open-data camera networks immediately on first run.
- **CORS & Mixed-Content Proxy**: Proxies live HLS (`.m3u8` / `.ts`) video streams and `.jpg` snapshots through `/api/hls` and `/api/img`, including automatic on-demand token refresh for short-lived stream URLs.
- **Multi-Camera Video Wall**: Pin any combination of live HLS streams, MP4 clips, embedded players, or auto-refreshing snapshots (`1s`–`10s` configurable rate) into a simultaneous multi-tile grid.
- **Color-Coded WebGL Map**:
  - 🟢 **Green**: Continuous live video streams (`HLS .m3u8` / `MP4`)
  - 🔵 **Cyan**: Live auto-refreshing DOT snapshots
  - 🟠 **Amber**: Embedded live/timelapse players (e.g., Windy Webcams)
  - 🟣 **Clusters**: Toggleable clustering (`Cluster Dense Areas`) with instant zoom-to-expand.
- **5 Real-Time OSINT Layers**:
  - ✈️ **Live Flights (ADS-B)** via `adsb.lol`
  - 🚢 **Live AIS Vessels** via `aisstream.io` WebSocket (free key)
  - 🌋 **Earthquakes** via USGS GeoJSON Feed
  - ⚠️ **Active Natural Events** via NASA EONET
  - 🌧️ **Live Weather Radar** via RainViewer
- **Security First**: `config.json` and `data/` are strictly `.gitignore`d so personal API keys and local caches are never committed.

---

## Quick Start

### Prerequisites
- **Node.js 18 or newer** ([nodejs.org](https://nodejs.org/))

### Installation & Launch
```bash
git clone https://github.com/pablo-2047/ARGUS-EYES.git
cd ARGUS-EYES
node server.js
```
> **Windows Shortcut**: Double-click **`START.bat`** to start the server and open `http://localhost:8080` automatically.

On first launch:
1. If `config.json` does not exist yet, the server automatically creates it from `config.example.json`.
2. It fetches and indexes all enabled public camera agencies, caching the compact index in `data/cameras.json` (auto-refreshed every 12 hours).
3. Open **`http://localhost:8080`** in any modern browser.

---

## Built-In Keyless Sources (Active Immediately)

No registration or keys needed — these sources start working automatically:

| Agency / Portal | Region | Feed Type | Approx. Feeds |
|---|---|---|---|
| **Caltrans (All 12 Districts)** | California, USA | Live HLS Video + Snapshots | ~3,400+ |
| **Travel Midwest / IDOT** | Illinois & Midwest, USA | Live Highway Snapshots | ~3,800+ |
| **CalOES Western US Webcams** | Western USA | Live Snapshots | ~3,050+ |
| **Fintraffic Digitraffic** | Finland (Nationwide) | Multi-Angle Road Weather Cams | ~2,270+ |
| **Minnesota 511 (MnDOT)** | Minnesota, USA | Live HLS + Snapshots | ~1,940+ |
| **COtrip (Colorado DOT)** | Colorado, USA | Live HLS + Snapshots | ~1,260+ |
| **Iowa DOT** | Iowa, USA | Live HLS + Snapshots | ~1,260+ |
| **TripCheck (Oregon DOT)** | Oregon, USA | Live Highway & Pass Cams | ~1,180+ |
| **OHGO (Ohio DOT)** | Ohio, USA | Live Highway Snapshots | ~1,150+ |
| **DriveBC** | British Columbia, Canada | Provincial Highway Cams | ~1,040+ |
| **Nebraska 511 (NDOT)** | Nebraska, USA | Statewide Highway Cams | ~1,040+ |
| **Hong Kong Transport Dept.** | Hong Kong | Citywide Traffic Snapshots | ~1,010+ |
| **MoDOT (Missouri DOT)** | Missouri, USA | Live HLS Video Streams | ~830+ |
| **Transport for London (TfL)** | London, UK | JamCams (Live MP4 + Snapshots) | ~825+ |
| **Mi Drive (Michigan DOT)** | Michigan, USA | Freeway Snapshots | ~800+ |
| **INDOT Trafficwise** | Indiana, USA | Statewide Highway Cams | ~780+ |
| **KanDrive (Kansas DOT)** | Kansas, USA | Live HLS + Snapshots | ~600+ |
| **Vegagerðin** | Iceland (Nationwide) | Ring Road & Pass Webcams | ~500+ |
| **DelDOT** | Delaware, USA | Live HLS Video Streams | ~370+ |
| **Mass511** | Massachusetts, USA | Highway Traffic Cams | ~310+ |
| **KYTC** | Kentucky, USA | Statewide Snapshots | ~250+ |
| **Live Traffic NSW** | Sydney & NSW, Australia | Live Traffic Snapshots | ~250+ |
| **NZTA** | New Zealand | National Highway Cams | ~245+ |
| **SD511** | South Dakota, USA | Highway & Weather Cams | ~125+ |
| **ALERTCalifornia** | California, USA | Mountain & Wildfire PTZ Cams | ~95+ |
| **Singapore LTA** | Singapore | Expressway Traffic Cams | Dynamic |

*(Note: Individual agency counts vary slightly based on live camera maintenance status upstream.)*

---

## Optional API Keys Guide (100% Free)

All keys below are **free** for personal/developer use. Never share or commit your `config.json` file.

### Where to Put Your Keys
Open `config.json` in the project root (created automatically on first run, or copy `config.example.json` to `config.json`) and paste keys into the `"keys"` object:

```json
{
  "port": 8080,
  "host": "127.0.0.1",
  "refreshHours": 12,
  "imageCacheSeconds": 1,
  "windyMaxCameras": 2000,
  "keys": {
    "carto": "",
    "windy": "",
    "aisstream": "",
    "trafikverket": "",
    "qldtraffic": "",
    "tfnsw": ""
  }
}
```

After saving `config.json`, click **📡 Sources → ↻ Rebuild Index Now** in the UI (or restart the server).

---

### 1. Global OSINT, Webcams & Basemaps

| Key Name | Service | What It Unlocks | How to Get a Free Key |
|---|---|---|---|
| `"aisstream"` | **AISStream** | Real-time global maritime ship & vessel tracking layer | 1. Go to [aisstream.io](https://aisstream.io/)<br>2. Sign in with GitHub or email<br>3. Generate an API key from your dashboard |
| `"windy"` | **Windy Webcams v3** | Tens of thousands of worldwide city, beach, mountain, and scenic webcams (with player embeds) | 1. Register at [api.windy.com](https://api.windy.com/)<br>2. Open your API Dashboard and create a **Webcams API v3** key |
| `"carto"` | **CARTO Basemaps** | Authorized high-quota dark & street map tiles (5M req/month free) | 1. Sign up at [app.carto.com](https://app.carto.com/)<br>2. Create a Basemaps API key *(optional — keyless tiles also work by default)* |

---

### 2. Regional & Country Networks

| Key Name | Agency / Country | What It Unlocks | How to Get a Free Key |
|---|---|---|---|
| `"trafikverket"` | **Trafikverket (Sweden)** | ~1,500+ nationwide Swedish road & traffic cameras | 1. Visit **[data.trafikverket.se](https://data.trafikverket.se)** *(not `api.trafikinfo...`, which is the raw XML endpoint)*<br>2. Click **Logga in** (Log in) and register<br>3. Generate an **API-nyckel** (Authentication Key) |
| `"qldtraffic"` | **QLDTraffic (Australia — QLD)** | Brisbane, Gold Coast, Sunshine Coast, Cairns cameras | 1. Visit [QLDTraffic Developers](https://qldtraffic.qld.gov.au/more/Developers-and-Data/index.html)<br>2. Request a free API key |
| `"tfnsw"` | **Transport for NSW (Australia)** | Full statewide NSW camera Open Data feed | 1. Register at [opendata.transport.nsw.gov.au](https://opendata.transport.nsw.gov.au/)<br>2. Create an app and subscribe to the Live Traffic Cameras API |

---

### 3. North American 511 Networks (IBI Platform)

Register on any state/province developer portal below, click **Request API Key** under your profile, and paste it into `config.json`:

#### United States
| Key Name | State / Agency | Developer Portal Link |
|---|---|---|
| `"511fl"` | Florida (FL511) | [fl511.com/developers](https://fl511.com/developers) |
| `"511ny"` | New York State (511NY) | [511ny.org/developers](https://511ny.org/developers) |
| `"511pa"` | Pennsylvania (511PA) | [511pa.com/developers](https://www.511pa.com/developers) |
| `"511ga"` | Georgia (511GA) | [511ga.org/developers](https://511ga.org/developers) |
| `"511az"` | Arizona (AZ511) | [az511.gov/developers](https://az511.gov/developers) |
| `"511nv"` | Nevada (NVroads) | [nvroads.com/developers](https://www.nvroads.com/developers) |
| `"511wi"` | Wisconsin (511WI) | [511wi.gov/developers](https://511wi.gov/developers) |
| `"511ut"` | Utah (UDOT Traffic) | [udottraffic.utah.gov/developers](https://udottraffic.utah.gov/developers) |
| `"511ct"` | Connecticut (CTroads) | [ctroads.org/developers](https://ctroads.org/developers) |
| `"511la"` | Louisiana (511LA) | [511la.org/developers](https://511la.org/developers) |
| `"511id"` | Idaho (511 Idaho) | [511.idaho.gov/developers](https://511.idaho.gov/developers) |
| `"511ne"` | New England (ME, NH, VT) | [newengland511.org/developers](https://newengland511.org/developers) |
| `"511ak"` | Alaska (511 Alaska) | [511.alaska.gov/developers](https://511.alaska.gov/developers) |

#### Canada
| Key Name | Province / Agency | Developer Portal Link |
|---|---|---|
| `"511on"` | Ontario (511ON) | [511on.ca/developers](https://511on.ca/developers) |
| `"511ab"` | Alberta (511AB) | [511.alberta.ca/developers](https://511.alberta.ca/developers) |
| `"511ns"` | Nova Scotia (511NS) | [511.novascotia.ca/developers](https://511.novascotia.ca/developers) |
| `"511nb"` | New Brunswick (511NB) | [511.gnb.ca/developers](https://511.gnb.ca/developers) |

---

## Adding Your Own Custom Cameras

Edit `custom_cameras.json` to add any public `.jpg` snapshot, `.m3u8` HLS stream, `.mp4`, or `iframe` embed URL:

```json
[
  {
    "id": "my-custom-cam",
    "name": "Example Highway Overpass",
    "lat": 37.7749,
    "lon": -122.4194,
    "hls": "https://example.com/stream/playlist.m3u8"
  }
]
```
Then click **📡 Sources → ↻ Rebuild Index Now**.

---

## Project Structure & API Reference

```
ARGUS-EYES/
├── server.js             # Local HTTP server, index builder, HLS/image proxies, OSINT feeds
├── sources.js            # Modular adapters for 26+ keyless & 20+ API-keyed public feeds
├── config.example.json   # Safe template configuration (tracked in Git)
├── config.json           # Local configuration & API keys (gitignored — NEVER committed)
├── custom_cameras.json   # User-defined custom public streams
├── START.bat             # One-click Windows launcher
└── public/
    ├── index.html        # MapLibre GL + HLS.js HUD & Video Wall UI
    ├── style.css         # Dark tactical UI styles
    └── app.js            # Map layers, clustering, inspector, Video Wall & OSINT handlers
```

### Local Endpoints
| Endpoint | Description |
|---|---|
| `GET /api/index` | Compact columnar camera index (`[id, lon, lat, srcIdx, kind, name]`) |
| `GET /api/status` | Live index build status, per-source camera counts, and connected ship count |
| `GET /api/cam?id=...` | Full camera metadata (resolves fresh dynamic URLs/tokens on demand) |
| `GET /api/img?id=...` | CORS-safe snapshot image proxy (`&fresh=1` bypasses cache) |
| `GET /api/hls?id=...` | CORS-safe HLS `.m3u8` & `.ts` segment proxy |
| `GET /api/flights?lat=...&lon=...&dist=...` | Live ADS-B aircraft positions via `adsb.lol` |
| `GET /api/ships?bbox=...` | Live AIS maritime vessels from `aisstream.io` |
| `GET /api/quakes` | USGS M2.5+ past 7 days earthquakes GeoJSON |
| `GET /api/events` | NASA EONET open natural events GeoJSON |
| `GET /api/radar` | RainViewer live weather radar tile manifest |
| `GET /api/refresh` | Trigger background rebuild of the camera index |

---

## Security & Secret Hygiene

- **`config.json` is listed in `.gitignore`**: Your API keys (`windy`, `aisstream`, `carto`, `511*`, etc.) stay strictly on your local disk.
- **`data/` is listed in `.gitignore`**: Cached index files are regenerated locally per installation.
- **No keys in frontend code**: `public/app.js` contains zero hardcoded API keys; optional basemap keys are read dynamically from `config.json` at runtime via `/api/client-config`.

---

## Disclaimer

ARGUS EYES only indexes **publicly accessible, official government traffic agencies, open-data portals, and public webcam APIs** (such as DOT 511 portals, TfL, Fintraffic, Caltrans, Windy, etc.). It does not scan private networks or access unauthorized streams. Users are responsible for complying with the terms of service of any optional third-party APIs they configure and applicable local laws.

## License

[MIT](LICENSE)
