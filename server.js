// ─────────────────────────────────────────────────────────────────────────────
//  ARGUS EYES – local server (zero npm dependencies, Node 18+)
//  • aggregates public camera feeds into one index (cached in ./data)
//  • proxies snapshots + HLS so the browser never hits CORS / mixed-content
//  • extra live layers: flights (adsb.lol), earthquakes (USGS),
//    natural events (NASA EONET), ships (aisstream.io, optional key)
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, optionalSources, valid, UA, http as fetchx } from './sources.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const PUB = path.join(ROOT, 'public');
fs.mkdirSync(DATA, { recursive: true });

const cfgPath = path.join(ROOT, 'config.json');
const exampleCfgPath = path.join(ROOT, 'config.example.json');
if (!fs.existsSync(cfgPath) && fs.existsSync(exampleCfgPath)) {
  fs.copyFileSync(exampleCfgPath, cfgPath);
  console.log('[config] created config.json from config.example.json');
}
const cfg = Object.assign(
  { port: 8080, host: '127.0.0.1', refreshHours: 12, imageCacheSeconds: 1, keys: {} },
  fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}
);

// ═════════════════════════════ Camera index ═════════════════════════════════
let DB = { generated: 0, sources: [], cams: [] };   // cams: full records
let BYID = new Map();
let INDEX_JSON = null;                                // pre-serialized compact index
let building = false;

const KIND = { image: 0, video: 1, page: 2, youtube: 3 };
function kindOf(c) { return c.hls || c.mp4 ? KIND.video : c.youtube ? KIND.youtube : c.img ? KIND.image : KIND.page; }

function allSources() { return [...SOURCES, ...optionalSources(cfg), customSource()]; }

function customSource() {
  return {
    key: 'custom', name: 'My custom cameras', country: '★', region: 'custom_cameras.json',
    async fetch() {
      try { return JSON.parse(await fsp.readFile(path.join(ROOT, 'custom_cameras.json'), 'utf8')).filter((c) => !c._comment).map((c, i) => ({ id: c.id || i, ...c })); }
      catch { return []; }
    },
  };
}

function rebuildMaps() {
  BYID = new Map(DB.cams.map((c) => [c.id, c]));
  const srcIdx = new Map(DB.sources.map((s, i) => [s.key, i]));
  INDEX_JSON = JSON.stringify({
    generated: DB.generated,
    sources: DB.sources,
    // compact rows: [id, lon, lat, sourceIndex, kind, name]
    cams: DB.cams.map((c) => [c.id, +c.lon.toFixed(5), +c.lat.toFixed(5), srcIdx.get(c.src), kindOf(c), c.name || '']),
  });
}

async function buildIndex(reason = 'scheduled') {
  if (building) return;
  building = true;
  const t0 = Date.now();
  console.log(`\n[index] building (${reason}) …`);
  const results = await Promise.all(allSources().map(async (s) => {
    const t = Date.now();
    try {
      const rows = (await s.fetch()) || [];
      const seen = new Set();
      const cams = [];
      for (const r of rows) {
        if (!r) continue;
        r.lat = typeof r.lat === 'string' ? parseFloat(r.lat) : r.lat;
        r.lon = typeof r.lon === 'string' ? parseFloat(r.lon) : r.lon;
        if (!valid(r)) continue;
        const id = `${s.key}:${r.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        cams.push({ ...r, id, nid: String(r.id), src: s.key, name: (r.name || '').replace(/\s+/g, ' ').trim() });
      }
      console.log(`  ✔ ${s.name.padEnd(44)} ${String(cams.length).padStart(6)}  (${Date.now() - t} ms)`);
      return { meta: { key: s.key, name: s.name, country: s.country, region: s.region, count: cams.length, ok: true, ms: Date.now() - t }, cams };
    } catch (e) {
      console.log(`  ✖ ${s.name.padEnd(44)}  failed: ${e.cause?.code || e.message}`);
      // keep the previous successful data for this source, if any
      const prev = DB.cams.filter((c) => c.src === s.key);
      return { meta: { key: s.key, name: s.name, country: s.country, region: s.region, count: prev.length, ok: false, error: String(e.cause?.code || e.message), ms: Date.now() - t }, cams: prev };
    }
  }));
  DB = { generated: Date.now(), sources: results.map((r) => r.meta), cams: results.flatMap((r) => r.cams) };
  rebuildMaps();
  await fsp.writeFile(path.join(DATA, 'cameras.json'), JSON.stringify(DB));
  console.log(`[index] ${DB.cams.length.toLocaleString()} cameras from ${DB.sources.filter((s) => s.count).length} sources in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  building = false;
}

async function loadIndex() {
  try {
    DB = JSON.parse(await fsp.readFile(path.join(DATA, 'cameras.json'), 'utf8'));
    rebuildMaps();
    console.log(`[index] loaded cache: ${DB.cams.length.toLocaleString()} cameras (built ${new Date(DB.generated).toLocaleString()})`);
  } catch { console.log('[index] no cache yet'); }
  const stale = Date.now() - DB.generated > cfg.refreshHours * 3600e3;
  if (!DB.cams.length) await buildIndex('first run');
  else if (stale) buildIndex('cache stale');
  setInterval(() => buildIndex(), cfg.refreshHours * 3600e3).unref();
}

// ═════════════════════════════ Helpers ══════════════════════════════════════
const cache = new Map(); // key -> {t, ttl, value}
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.value;
  if (hit?.pending) return hit.pending;
  const pending = fn().then((value) => { cache.set(key, { t: Date.now(), value }); return value; })
    .catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { ...(hit || { t: 0 }), pending });
  return pending;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of cache) if (!v.pending && now - v.t > 600e3) cache.delete(k); }, 60e3).unref();

const srcByKey = () => Object.fromEntries(allSources().map((s) => [s.key, s]));
let SRC = srcByKey();

async function resolveCam(id) {
  const c = BYID.get(id);
  if (!c) return null;
  const s = SRC[c.src];
  if (s?.resolve) {
    try { return await cached('res:' + id, 50e3, () => s.resolve(c)); } catch { return c; }
  }
  return c;
}

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const sendJSON = (res, obj, code = 200) => send(res, code, typeof obj === 'string' ? obj : JSON.stringify(obj));

// ═════════════════════════════ Live layers ══════════════════════════════════
async function flights(lat, lon, dist) {
  const k = `fl:${lat.toFixed(1)},${lon.toFixed(1)},${dist}`;
  return cached(k, 9000, async () => {
    const r = await fetchx(`https://api.adsb.lol/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${dist}`, { timeout: 15000 });
    const j = await r.json();
    return (j.ac || []).filter((a) => a.lat != null).map((a) => [a.hex, a.lon, a.lat, a.track ?? a.true_heading ?? 0, a.alt_baro === 'ground' ? 0 : a.alt_baro ?? 0, (a.flight || '').trim(), a.t || '', a.r || '', Math.round(a.gs || 0)]);
  });
}
const quakes = () => cached('quakes', 300e3, async () => (await fetchx('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson')).json());
const eonet = () => cached('eonet', 1800e3, async () => (await fetchx('https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&days=30', { timeout: 30000 })).json());
const radar = () => cached('radar', 300e3, async () => (await fetchx('https://api.rainviewer.com/public/weather-maps.json')).json());

// Ships via aisstream.io websocket (optional, free key at aisstream.io)
const SHIPS = new Map();
function startAIS() {
  if (!cfg.keys.aisstream || typeof WebSocket === 'undefined') return;
  const connect = () => {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.onopen = () => { console.log('[ais] connected'); ws.send(JSON.stringify({ APIKey: cfg.keys.aisstream, BoundingBoxes: [[[-90, -180], [90, 180]]], FilterMessageTypes: ['PositionReport', 'ShipStaticData'] })); };
    ws.onmessage = async (ev) => {
      try {
        const m = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text());
        const md = m.MetaData || {}; const id = md.MMSI;
        if (!id) return;
        const s = SHIPS.get(id) || { id };
        if (m.MessageType === 'PositionReport') { const p = m.Message.PositionReport; Object.assign(s, { lat: p.Latitude, lon: p.Longitude, cog: p.Cog, sog: p.Sog, hdg: p.TrueHeading }); }
        if (m.MessageType === 'ShipStaticData') { const p = m.Message.ShipStaticData; Object.assign(s, { type: p.Type, dest: (p.Destination || '').trim() }); }
        s.name = (md.ShipName || s.name || '').trim(); s.t = Date.now();
        SHIPS.set(id, s);
        if (SHIPS.size > 120000) { const old = Date.now() - 1800e3; for (const [k, v] of SHIPS) if (v.t < old) SHIPS.delete(k); }
      } catch { /* ignore */ }
    };
    ws.onclose = () => { console.log('[ais] disconnected, retrying in 15 s'); setTimeout(connect, 15000); };
    ws.onerror = () => {};
  };
  connect();
}

// ═════════════════════════════ Proxies ══════════════════════════════════════
async function proxyImage(res, id, fresh = false) {
  const c = await resolveCam(id);
  if (!c || !c.img) return send(res, 404, 'no image', 'text/plain');
  try {
    const ttl = fresh ? 0 : cfg.imageCacheSeconds * 1000;
    const { buf, type } = await cached('img:' + id, ttl, async () => {
      const r = await fetchx(c.img, { timeout: 20000, headers: { Referer: new URL(c.img).origin + '/' } });
      const type = r.headers.get('content-type') || 'image/jpeg';
      if (!/image|octet/i.test(type)) throw new Error('not an image');
      return { buf: Buffer.from(await r.arrayBuffer()), type };
    });
    send(res, 200, buf, type, { 'Cache-Control': 'no-store' });
  } catch (e) {
    send(res, 502, 'upstream error: ' + (e.cause?.code || e.message), 'text/plain');
  }
}

async function proxyHLS(res, id, u) {
  const c = await resolveCam(id);
  if (!c || !c.hls) return send(res, 404, 'no stream', 'text/plain');
  const baseUrl = new URL(c.hls);
  const target = u ? new URL(u) : baseUrl;
  const rootDomain = baseUrl.hostname.split('.').slice(-2).join('.');
  if (target.hostname !== baseUrl.hostname && !target.hostname.endsWith('.' + rootDomain)) {
    return send(res, 403, 'host not allowed', 'text/plain');
  }
  try {
    const r = await fetchx(target.href, { timeout: 20000, headers: { Referer: baseUrl.origin + '/' } });
    const finalUrl = new URL(r.url || target.href);
    const type = r.headers.get('content-type') || '';
    if (/mpegurl|m3u8/i.test(type) || finalUrl.pathname.endsWith('.m3u8')) {
      const body = await r.text();
      const rewritten = body.split('\n').map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) return t.replace(/URI="([^"]+)"/g, (_, x) => `URI="/api/hls?id=${encodeURIComponent(id)}&u=${encodeURIComponent(new URL(x, finalUrl).href)}"`);
        return `/api/hls?id=${encodeURIComponent(id)}&u=${encodeURIComponent(new URL(t, finalUrl).href)}`;
      }).join('\n');
      return send(res, 200, rewritten, 'application/vnd.apple.mpegurl');
    }
    send(res, 200, Buffer.from(await r.arrayBuffer()), type || 'video/mp2t');
  } catch (e) { send(res, 502, 'upstream error: ' + (e.cause?.code || e.message), 'text/plain'); }
}

// ═════════════════════════════ HTTP server ══════════════════════════════════
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  try {
    switch (url.pathname) {
      case '/api/index': return sendJSON(res, INDEX_JSON || '{"cams":[],"sources":[]}');
      case '/api/client-config': return sendJSON(res, { cartoKey: cfg.keys?.carto || '' });
      case '/api/status': return sendJSON(res, { building, generated: DB.generated, total: DB.cams.length, sources: DB.sources, ships: SHIPS.size, keys: Object.keys(cfg.keys).filter((k) => cfg.keys[k]) });
      case '/api/refresh': buildIndex('manual'); return sendJSON(res, { ok: true, building: true });
      case '/api/cam': {
        const c = await resolveCam(q.id);
        if (!c) return sendJSON(res, { error: 'not found' }, 404);
        const s = DB.sources.find((x) => x.key === c.src) || {};
        return sendJSON(res, { ...c, srcName: s.name, country: s.country });
      }
      case '/api/img': return proxyImage(res, q.id, q.fresh === '1');
      case '/api/hls': return proxyHLS(res, q.id, q.u);
      case '/api/flights': return sendJSON(res, await flights(+q.lat || 0, +q.lon || 0, Math.min(250, Math.max(10, +q.dist || 150))));
      case '/api/quakes': return sendJSON(res, await quakes());
      case '/api/events': return sendJSON(res, await eonet());
      case '/api/radar': return sendJSON(res, await radar());
      case '/api/ships': {
        const [w, s, e, n] = (q.bbox || '-180,-90,180,90').split(',').map(Number);
        const old = Date.now() - 1800e3; const out = [];
        for (const v of SHIPS.values()) if (v.lat != null && v.t > old && v.lon >= w && v.lon <= e && v.lat >= s && v.lat <= n) { out.push([v.id, v.lon, v.lat, v.hdg && v.hdg < 360 ? v.hdg : v.cog || 0, v.name, v.sog || 0, v.type || 0, v.dest || '']); if (out.length > 15000) break; }
        return sendJSON(res, { enabled: !!cfg.keys.aisstream, total: SHIPS.size, ships: out });
      }
    }
    // static files
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (!p) p = 'index.html';
    const file = path.join(PUB, p);
    if (!file.startsWith(PUB)) return send(res, 403, 'forbidden', 'text/plain');
    const data = await fsp.readFile(file).catch(() => null);
    if (!data) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  } catch (e) {
    send(res, 500, JSON.stringify({ error: String(e.message || e) }));
  }
});

server.listen(cfg.port, cfg.host, async () => {
  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║   ARGUS EYES  →  http://localhost:${String(cfg.port).padEnd(9)}║`);
  console.log(`  ╚══════════════════════════════════════════════╝`);
  startAIS();
  await loadIndex();
  SRC = srcByKey();
});
