// ─────────────────────────────────────────────────────────────────────────────
//  Camera source adapters.
//  Every adapter returns an array of normalized records:
//    { id, name, lat, lon, img?, hls?, mp4?, page?, youtube?, iframe?, dir?, region? }
//  Only OFFICIAL / OPEN public feeds are used (government traffic agencies,
//  open-data portals, and APIs that explicitly offer public webcam data).
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 ArgusEyes/1.0 (local)';

export async function http(url, { timeout = 60000, headers = {}, method = 'GET', body } = {}) {
  const r = await fetch(url, {
    method, body,
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split('?')[0]}`);
  return r;
}
const json = async (u, o) => (await http(u, o)).json();
const text = async (u, o) => (await http(u, o)).text();

const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const valid = (r) => r && r.lat != null && r.lon != null && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180 && !(r.lat === 0 && r.lon === 0) && (r.img || r.hls || r.mp4 || r.page || r.youtube || r.iframe);
const decode = (s = '') => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const xmlTag = (block, tag) => { const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? decode(m[1]) : null; };

// Generic ArcGIS FeatureServer pager (outSR=4326)
async function arcgisAll(base, { pageSize = 1000, where = '1=1' } = {}) {
  const out = [];
  for (let offset = 0; offset < 200000; offset += pageSize) {
    const u = `${base}/query?where=${encodeURIComponent(where)}&outFields=*&f=json&outSR=4326&resultOffset=${offset}&resultRecordCount=${pageSize}`;
    const j = await json(u);
    if (j.error) throw new Error(j.error.message || 'ArcGIS error');
    const f = j.features || [];
    out.push(...f);
    if (f.length < pageSize && !j.exceededTransferLimit) break;
    if (!f.length) break;
  }
  return out;
}

// CARS Program state 511 adapter (CO, MN, IN, KS, NE, MA, SD)
function carsSource(key, hostPrefix, name, region) {
  return {
    key, name, country: 'US', region,
    async fetch() {
      const j = await json(`https://${hostPrefix}tg.carsprogram.org/cameras_v1/api/cameras`);
      const out = [];
      for (const c of j) {
        if (c.public === false || c.active === false) continue;
        (c.views || []).forEach((v, i) => {
          const u = v.url || '';
          const hls = /\.m3u8/i.test(u) ? u : (v.videoUrl && /\.m3u8/i.test(v.videoUrl) ? v.videoUrl : null);
          const img = /\.m3u8/i.test(u) ? (v.videoPreviewUrl || null) : (u || v.videoPreviewUrl || null);
          if (!img && !hls) return;
          out.push({
            id: `${c.id}-${i}`,
            name: `${c.name}${v.name && v.name !== c.name ? ' · ' + v.name : ''}`,
            lat: c.location?.latitude, lon: c.location?.longitude,
            img, hls, region: c.location?.cityReference || c.cameraOwner?.name || region,
          });
        });
      }
      return out;
    },
    // Refresh short-lived JWT tokens on HLS streams (e.g. Kansas DOT)
    async resolve(rec) {
      if (!rec.hls) return rec;
      const [cid, vIdx] = String(rec.nid).split('-');
      const c = await json(`https://${hostPrefix}tg.carsprogram.org/cameras_v1/api/cameras/${cid}`, { timeout: 10000 });
      const v = c.views?.[Number(vIdx) || 0];
      if (!v) return rec;
      const u = v.url || '';
      const hls = /\.m3u8/i.test(u) ? u : (v.videoUrl && /\.m3u8/i.test(v.videoUrl) ? v.videoUrl : rec.hls);
      const img = /\.m3u8/i.test(u) ? (v.videoPreviewUrl || rec.img) : (u || v.videoPreviewUrl || rec.img);
      return { ...rec, hls, img };
    },
  };
}

// ═════════════════════════════  KEYLESS SOURCES  ═════════════════════════════
export const SOURCES = [
  {
    key: 'caltrans', name: 'Caltrans (California DOT – 12 Districts)', country: 'US', region: 'California',
    async fetch() {
      const all = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
        const d = i + 1, dd = String(d).padStart(2, '0');
        try {
          const j = await json(`https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${dd}.json`, { timeout: 120000 });
          return j.data.map(({ cctv: c }) => ({
            id: `d${d}-${c.index}`,
            name: decode(c.location.locationName).replace(/^\w+\s*--\s*/, '') + (c.location.nearbyPlace ? ` · ${c.location.nearbyPlace}` : ''),
            lat: num(c.location.latitude), lon: num(c.location.longitude),
            img: c.imageData?.static?.currentImageURL || null,
            hls: c.imageData?.streamingVideoURL || null,
            dir: c.location.direction, region: c.location.county,
            off: c.inService === 'false',
          })).filter((r) => !r.off);
        } catch { return []; }
      }));
      return all.flat();
    },
  },
  {
    key: 'alertca', name: 'ALERTCalifornia (Wildfire & Mountain HD Cams)', country: 'US', region: 'California',
    async fetch() {
      const f = await arcgisAll('https://services8.arcgis.com/X84q166Srnyl4JMV/arcgis/rest/services/ALERTCalifornia_Camera_Feed/FeatureServer/0');
      return f.filter(({ attributes: a }) => a.isOnline !== 'offline' && a.imageURL).map(({ attributes: a, geometry: g }) => ({
        id: a.OBJECTID,
        name: `${a.cameraName || a.siteId}${a.county ? ' · ' + a.county : ''}`,
        lat: g?.y, lon: g?.x,
        img: a.imageURL, page: a.cameraURL, region: a.county,
      }));
    },
  },
  {
    key: 'caloes', name: 'CalOES Western US Webcams', country: 'US', region: 'Western US',
    async fetch() {
      const f = await arcgisAll('https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/CalOES_California_Webcams/FeatureServer/0');
      return f.filter(({ attributes: a }) => a.Thumbnail_Url && a.Source !== 'Alert California').map(({ attributes: a, geometry: g }) => ({
        id: a.OBJECTID,
        name: `${a.Location || a.Camera_ID || 'Webcam'}${a.County ? ' · ' + a.County : ''}`,
        lat: num(a.Latitude) ?? g?.y, lon: num(a.Longitude) ?? g?.x,
        img: a.Thumbnail_Url, page: a.Webcam_URL, region: a.State || a.County,
      }));
    },
  },
  {
    key: 'tfl', name: 'Transport for London JamCams', country: 'GB', region: 'London',
    async fetch() {
      const j = await json('https://api.tfl.gov.uk/Place/Type/JamCam');
      return j.map((p) => {
        const prop = Object.fromEntries((p.additionalProperties || []).map((a) => [a.key, a.value]));
        return { id: p.id, name: p.commonName, lat: p.lat, lon: p.lon, img: prop.imageUrl, mp4: prop.videoUrl, dir: prop.view, off: prop.available === 'false' };
      }).filter((r) => !r.off);
    },
  },
  {
    key: 'sg', name: 'Singapore LTA Traffic Images', country: 'SG', region: 'Singapore', dynamic: true,
    async fetch() {
      const j = await json('https://api.data.gov.sg/v1/transport/traffic-images');
      return (j.items?.[0]?.cameras || []).map((c) => ({ id: c.camera_id, name: `Singapore LTA Cam #${c.camera_id}`, lat: c.location.latitude, lon: c.location.longitude, img: c.image }));
    },
    async resolve(rec) {
      const j = await json('https://api.data.gov.sg/v1/transport/traffic-images', { timeout: 15000 });
      const c = (j.items?.[0]?.cameras || []).find((x) => String(x.camera_id) === String(rec.nid));
      return c ? { ...rec, img: c.image } : rec;
    },
  },
  {
    key: 'fintraffic', name: 'Fintraffic Weathercams (Finland)', country: 'FI', region: 'Finland',
    async fetch() {
      const j = await json('https://tie.digitraffic.fi/api/weathercam/v1/stations', { headers: { 'Digitraffic-User': 'ArgusEyes/local' } });
      const out = [];
      for (const f of j.features) {
        const [lon, lat] = f.geometry.coordinates;
        for (const p of f.properties.presets || []) {
          if (p.inCollection === false) continue;
          out.push({ id: p.id, name: f.properties.name.replace(/_/g, ' ') + ` (${p.id.slice(-2)})`, lat, lon, img: `https://weathercam.digitraffic.fi/${p.id}.jpg` });
        }
      }
      return out;
    },
  },
  {
    key: 'hk', name: 'Hong Kong Transport Department', country: 'HK', region: 'Hong Kong',
    async fetch() {
      const x = await text('https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml');
      return [...x.matchAll(/<image>([\s\S]*?)<\/image>/g)].map(([, b]) => ({
        id: xmlTag(b, 'key'), name: xmlTag(b, 'description'), lat: num(xmlTag(b, 'latitude')), lon: num(xmlTag(b, 'longitude')),
        img: xmlTag(b, 'url'), region: xmlTag(b, 'district'),
      }));
    },
  },
  {
    key: 'nsw', name: 'Live Traffic NSW (Australia)', country: 'AU', region: 'New South Wales',
    async fetch() {
      const j = await json('https://www.livetraffic.com/datajson/all-feeds-web.json');
      return j.filter((f) => f.eventCategory === 'liveCams' && f.properties?.href).map((f) => ({
        id: f.id, name: f.properties.title, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
        img: f.properties.href, dir: f.properties.direction, region: f.properties.region, desc: f.properties.view,
      }));
    },
  },
  {
    key: 'drivebc', name: 'DriveBC (British Columbia)', country: 'CA', region: 'British Columbia',
    async fetch() {
      const j = await json('https://www.drivebc.ca/api/webcams/');
      return j.filter((c) => c.is_on !== false && c.should_appear !== false).map((c) => ({
        id: c.id, name: `${c.name} – ${c.caption || ''}`.replace(/\s–\s$/, ''), lat: c.location.coordinates[1], lon: c.location.coordinates[0],
        img: `https://www.drivebc.ca/images/${c.id}.jpg`, dir: c.orientation, region: c.region_name,
      }));
    },
  },
  {
    key: 'ohgo', name: 'OHGO (Ohio DOT)', country: 'US', region: 'Ohio',
    async fetch() {
      const j = await json('https://api.ohgo.com/roadmarkers/cameras');
      const out = [];
      for (const s of j) (s.Cameras || []).forEach((c, i) => out.push({
        id: `${s.Id}-${i}`, name: `${s.Description || s.Location}${c.Direction && c.Direction !== 'View' ? ' · ' + c.Direction : ''}`,
        lat: s.Latitude, lon: s.Longitude, img: c.LargeURL || c.SmallURL, dir: c.Direction,
      }));
      return out;
    },
  },
  {
    key: 'nzta', name: 'NZTA Traffic Cameras (New Zealand)', country: 'NZ', region: 'New Zealand',
    async fetch() {
      const x = await text('https://trafficnz.info/service/traffic/rest/4/cameras/all');
      return [...x.matchAll(/<camera>([\s\S]*?)<\/camera>/g)].map(([, b]) => {
        const clean = b.replace(/<journey>[\s\S]*?<\/journey>|<journeyLeg>[\s\S]*?<\/journeyLeg>|<region>[\s\S]*?<\/region>|<way>[\s\S]*?<\/way>/g, '');
        if (xmlTag(clean, 'offline') === 'true') return null;
        return {
          id: xmlTag(clean, 'id'), name: `${xmlTag(clean, 'name')} – ${xmlTag(clean, 'description') || ''}`, lat: num(xmlTag(clean, 'latitude')), lon: num(xmlTag(clean, 'longitude')),
          img: 'https://trafficnz.info' + xmlTag(clean, 'imageUrl'), dir: xmlTag(clean, 'direction'),
        };
      }).filter(Boolean);
    },
  },
  {
    key: 'iowa', name: 'Iowa DOT', country: 'US', region: 'Iowa',
    async fetch() {
      const f = await arcgisAll('https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0');
      return f.map(({ attributes: a }) => ({
        id: a.FID, name: `${a.Desc_ || a.REGION} · ${a.ImageName || ''}`, lat: a.latitude, lon: a.longitude,
        img: a.ImageURL, hls: a.VideoURL && /m3u8/i.test(a.VideoURL) ? a.VideoURL : null, region: a.Route,
      }));
    },
  },
  {
    key: 'travelmidwest', name: 'Travel Midwest / Illinois DOT', country: 'US', region: 'Illinois & Midwest',
    async fetch() {
      const f = await arcgisAll('https://services2.arcgis.com/aIrBD8yn1TDTEXoz/arcgis/rest/services/TrafficCamerasTM_Public/FeatureServer/0');
      return f.filter(({ attributes: a }) => a.TooOld !== 'true').map(({ attributes: a, geometry: g }) => ({
        id: a.OBJECTID, name: `${a.CameraLocation}${a.CameraDirection && a.CameraDirection !== 'NONE' ? ' · ' + a.CameraDirection : ''}`,
        lat: a.y ?? g?.y, lon: a.x ?? g?.x, img: a.SnapShot, page: a.ImgPath, dir: a.CameraDirection,
      }));
    },
  },
  {
    key: 'modot', name: 'MoDOT (Missouri DOT – Live Video)', country: 'US', region: 'Missouri',
    async fetch() {
      const f = await arcgisAll('https://services2.arcgis.com/jWXb6JPWtBjOCalT/arcgis/rest/services/MODOT_Traffic_Cameras/FeatureServer/1');
      return f.filter(({ attributes: a }) => a.STREAM_ERROR !== 'Y').map(({ attributes: a, geometry: g }) => {
        const u = (a.URL2 && a.URL2 !== '<Null>') ? a.URL2 : ((a.URL1 && a.URL1 !== '<Null>') ? a.URL1 : null);
        return {
          id: a.CAM_ID__ || a.OBJECTID, name: a.DESCRIPTION || `MoDOT #${a.OBJECTID}`,
          lat: a.Y ?? g?.y, lon: a.X ?? g?.x,
          hls: u && /m3u8/i.test(u) ? u : null, img: u && !/m3u8/i.test(u) ? u : null,
        };
      });
    },
  },
  {
    key: 'kytc', name: 'Kentucky Transportation Cabinet', country: 'US', region: 'Kentucky',
    async fetch() {
      const f = await arcgisAll('https://services2.arcgis.com/CcI36Pduqd0OR4W9/arcgis/rest/services/trafficCamerasCur_Prd/FeatureServer/0');
      return f.map(({ attributes: a }) => ({ id: a.OBJECTID, name: a.description || a.name, lat: a.latitude, lon: a.longitude, img: a.snapshot, region: a.county }));
    },
  },
  carsSource('cotrip', 'co', 'COtrip (Colorado DOT)', 'Colorado'),
  carsSource('mn511', 'mn', 'Minnesota 511 (MnDOT)', 'Minnesota'),
  carsSource('in511', 'in', 'INDOT Trafficwise (Indiana)', 'Indiana'),
  carsSource('kandrive', 'ks', 'KanDrive (Kansas DOT)', 'Kansas'),
  carsSource('ne511', 'ne', 'Nebraska 511 (NDOT)', 'Nebraska'),
  carsSource('mass511', 'ma', 'Mass511 (Massachusetts DOT)', 'Massachusetts'),
  carsSource('sd511', 'sd', 'SD511 (South Dakota DOT)', 'South Dakota'),
  {
    key: 'tripcheck', name: 'TripCheck (Oregon DOT)', country: 'US', region: 'Oregon',
    async fetch() {
      const j = await json('https://tripcheck.com/Scripts/map/data/cctvinventory.js');
      return j.features.map(({ attributes: a }) => ({
        id: a.cameraId + '-' + a.publishedImageId, name: a.title, lat: a.latitude, lon: a.longitude,
        img: `https://tripcheck.com/RoadCams/cams/${encodeURIComponent(a.filename)}`, region: (a.route || '').trim(),
      }));
    },
  },
  {
    key: 'midrive', name: 'Mi Drive (Michigan DOT)', country: 'US', region: 'Michigan',
    async fetch() {
      const j = await json('https://mdotjboss.state.mi.us/MiDrive/camera/list');
      return j.map((c) => {
        const ll = (c.county || '').match(/lat=([-\d.]+)&(?:amp;)?lon=([-\d.]+)/);
        const id = (c.county || '').match(/[?&](?:amp;)?id=(\d+)/);
        const src = (c.image || '').match(/src="([^"]+)"/);
        if (!ll || !src) return null;
        return { id: id ? id[1] : src[1], name: `${c.route}${decode(c.location)}`, lat: num(ll[1]), lon: num(ll[2]), img: decode(src[1]), desc: c.direction };
      }).filter(Boolean);
    },
  },
  {
    key: 'vegagerdin', name: 'Vegagerðin (Iceland Road Admin.)', country: 'IS', region: 'Iceland',
    async fetch() {
      const j = await json('https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1');
      return j.map((c, i) => ({ id: `${c.Maelist_nr}-${i}`, name: `${c.Myndavel} – ${c.Skyring || ''}`, lat: c.Breidd, lon: c.Lengd, img: c.Slod, region: c.Vegheiti }));
    },
  },
  {
    key: 'deldot', name: 'DelDOT (Delaware – Live Video)', country: 'US', region: 'Delaware',
    async fetch() {
      const j = await json('https://tmc.deldot.gov/json/videocamera.json');
      return (j.videoCameras || []).filter((c) => c.enabled !== false && c.status !== 'Inactive').map((c) => ({
        id: c.id, name: c.title, lat: c.lat, lon: c.lon, hls: c.urls?.m3u8s || c.urls?.m3u8, region: c.county,
      }));
    },
  },
];

// ═══════════════════  OPTIONAL SOURCES (free API key required)  ══════════════
const IBI_SITES = [
  ['511on', 'Ontario 511', 'CA', 'https://511on.ca'], ['511ab', 'Alberta 511', 'CA', 'https://511.alberta.ca'],
  ['511ns', 'Nova Scotia 511', 'CA', 'https://511.novascotia.ca'], ['511nb', 'New Brunswick 511', 'CA', 'https://511.gnb.ca'],
  ['511az', 'Arizona AZ511', 'US', 'https://az511.gov'], ['511nv', 'Nevada NVroads', 'US', 'https://www.nvroads.com'],
  ['511ga', 'Georgia 511', 'US', 'https://511ga.org'], ['511wi', 'Wisconsin 511', 'US', 'https://511wi.gov'],
  ['511ct', 'Connecticut CTroads', 'US', 'https://ctroads.org'], ['511la', 'Louisiana 511', 'US', 'https://www.511la.org'],
  ['511id', 'Idaho 511', 'US', 'https://511.idaho.gov'], ['511ne', 'New England 511', 'US', 'https://newengland511.org'],
  ['511fl', 'Florida FL511', 'US', 'https://fl511.com'], ['511ak', 'Alaska 511', 'US', 'https://511.alaska.gov'],
  ['511pa', 'Pennsylvania 511PA', 'US', 'https://www.511pa.com'], ['511ut', 'Utah UDOT Traffic', 'US', 'https://udottraffic.utah.gov'],
  ['511ny', '511NY (New York State)', 'US', 'https://511ny.org'],
];
export function optionalSources(cfg) {
  const k = cfg.keys || {};
  const out = [];
  for (const [key, name, country, base] of IBI_SITES) {
    if (!k[key]) continue;
    out.push({
      key, name, country, region: name,
      async fetch() {
        const j = await json(`${base}/api/v2/get/cameras?key=${encodeURIComponent(k[key])}&format=json`);
        const rows = [];
        for (const c of j) {
          const views = c.Views || (c.Url ? [{ Id: c.ID, Url: c.Url, Description: c.Name, VideoUrl: c.VideoUrl }] : []);
          views.forEach((v, i) => {
            if (v.Status && /disabled|offline/i.test(v.Status)) return;
            const vid = v.VideoUrl || c.VideoUrl;
            rows.push({
              id: `${c.Id ?? c.ID}-${v.Id ?? i}`, name: [c.Roadway || c.RoadwayName, c.Location || c.Name, v.Description].filter(Boolean).join(' · '),
              lat: num(c.Latitude), lon: num(c.Longitude), img: v.Url, hls: vid && /m3u8/i.test(vid) ? vid : null, dir: c.Direction || c.DirectionOfTravel,
            });
          });
        }
        return rows;
      },
    });
  }
  if (k.trafikverket) out.push({
    key: 'trafikverket', name: 'Trafikverket (Sweden)', country: 'SE', region: 'Sweden',
    async fetch() {
      const body = `<REQUEST><LOGIN authenticationkey="${k.trafikverket}"/><QUERY objecttype="Camera" schemaversion="1"><FILTER><EQ name="Active" value="true"/></FILTER></QUERY></REQUEST>`;
      const j = await json('https://api.trafikinfo.trafikverket.se/v2/data.json', { method: 'POST', body, headers: { 'Content-Type': 'text/xml' } });
      return (j.RESPONSE?.RESULT?.[0]?.Camera || []).map((c) => {
        const m = (c.Geometry?.WGS84 || '').match(/POINT \(([-\d.]+) ([-\d.]+)\)/);
        return m && { id: c.Id, name: c.Name, lat: num(m[2]), lon: num(m[1]), img: c.PhotoUrl ? c.PhotoUrl + '?type=fullsize' : null, dir: c.Direction };
      }).filter(Boolean);
    },
  });
  if (k.qldtraffic) out.push({
    key: 'qldtraffic', name: 'QLDTraffic (Queensland)', country: 'AU', region: 'Queensland',
    async fetch() {
      const j = await json(`https://api.qldtraffic.qld.gov.au/v1/webcams?apikey=${encodeURIComponent(k.qldtraffic)}`);
      const features = j.features || j;
      return (features || []).map((f) => {
        const p = f.properties || f;
        const [lon, lat] = f.geometry?.coordinates || [p.longitude, p.latitude];
        return {
          id: p.id || p.camera_id,
          name: p.description || p.name || 'Queensland Camera',
          lat: num(lat), lon: num(lon),
          img: p.image_url || p.url,
          region: p.district || 'Queensland',
        };
      }).filter((r) => r.lat && r.lon && r.img);
    },
  });
  if (k.tfnsw) out.push({
    key: 'tfnsw_full', name: 'Transport for NSW (Full Open Data Network)', country: 'AU', region: 'New South Wales',
    async fetch() {
      const j = await json('https://api.transport.nsw.gov.au/v1/live/cameras', { headers: { 'Authorization': `apikey ${k.tfnsw}` } });
      const list = j.features || j;
      return (list || []).map((f) => {
        const p = f.properties || f;
        const [lon, lat] = f.geometry?.coordinates || [p.lon, p.lat];
        return {
          id: f.id || p.id,
          name: p.title || p.name || 'NSW Camera',
          lat: num(lat), lon: num(lon),
          img: p.href || p.url,
          dir: p.direction,
          region: p.region || 'NSW',
        };
      }).filter((r) => r.lat && r.lon && r.img);
    },
  });
  if (k.windy) out.push({
    key: 'windy', name: 'Windy Webcams (worldwide)', country: '🌍', region: 'Worldwide', dynamic: true,
    async fetch() {
      const rows = [];
      const max = cfg.windyMaxCameras || 1000;
      for (let off = 0; off < max; off += 50) {
        let j;
        try { j = await json(`https://api.windy.com/webcams/api/v3/webcams?limit=50&offset=${off}&include=location`, { headers: { 'x-windy-api-key': k.windy } }); } catch { break; }
        const w = j.webcams || [];
        for (const c of w) rows.push({ id: c.webcamId, name: c.title, lat: c.location?.latitude, lon: c.location?.longitude, page: `https://www.windy.com/webcams/${c.webcamId}`, iframe: 'pending' });
        if (w.length < 50) break;
      }
      return rows;
    },
    async resolve(rec) {
      const j = await json(`https://api.windy.com/webcams/api/v3/webcams/${rec.nid}?include=images,player,urls`, { headers: { 'x-windy-api-key': k.windy }, timeout: 15000 });
      return { ...rec, img: j.images?.current?.preview || j.images?.current?.thumbnail || null, iframe: j.player?.live || j.player?.day || null, page: j.urls?.detail || rec.page };
    },
  });
  return out;
}

export { valid, UA };
