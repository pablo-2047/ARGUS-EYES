// ─────────────────────────────────────────────────────────────────────────────
//  ARGUS EYES – Frontend Application (MapLibre GL + HLS.js)
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  sources: [],
  cams: [],          // [id, lon, lat, srcIdx, kind, name]
  byId: new Map(),
  enabledSrc: new Set(),
  kindFilter: 'all', // 'all' | 'video' | 'image'
  selectedId: null,
  activeHls: null,
  refreshTimer: null,
  wallIds: JSON.parse(localStorage.getItem('argus_eyes_wall') || localStorage.getItem('wca_wall') || '[]'),
  wallHls: [],
  wallTimer: null,
  flightsTimer: null,
  shipsTimer: null,
};

const $ = (id) => document.getElementById(id);

let cartoQuery = '';
try {
  const c = await (await fetch('/api/client-config', { signal: AbortSignal.timeout(2500) })).json();
  if (c?.cartoKey) cartoQuery = `?key=${encodeURIComponent(c.cartoKey)}`;
} catch { /* fallback to keyless CARTO tiles */ }

// ═════════════════════════════ 1. Map Initialization ════════════════════════
const BASE_STYLE = {
  version: 8,
  glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
  sources: {
    dark: {
      type: 'raster',
      tiles: [
        `https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png${cartoQuery}`,
        `https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png${cartoQuery}`
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap · © CARTO',
    },
    sat: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: '© Esri World Imagery',
    },
    satLabels: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
    },
    street: {
      type: 'raster',
      tiles: [
        `https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png${cartoQuery}`,
        `https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png${cartoQuery}`
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap · © CARTO',
    },
  },
  layers: [
    { id: 'base-dark', type: 'raster', source: 'dark', layout: { visibility: 'visible' } },
    { id: 'base-sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
    { id: 'base-sat-lbl', type: 'raster', source: 'satLabels', layout: { visibility: 'none' } },
    { id: 'base-street', type: 'raster', source: 'street', layout: { visibility: 'none' } },
  ],
};

const map = new maplibregl.Map({
  container: 'map',
  style: BASE_STYLE,
  center: [-30, 34],
  zoom: 2.3,
  maxPitch: 60,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

map.on('mousemove', (e) => {
  $('cursorCoords').textContent = `LAT ${e.lngLat.lat.toFixed(4)} · LON ${e.lngLat.lng.toFixed(4)} · Z${map.getZoom().toFixed(1)}`;
});

map.on('load', async () => {
  setupMapLayers();
  await loadCameraIndex();
  // Check URL hash (#cam=...)
  if (location.hash.startsWith('#cam=')) {
    const id = decodeURIComponent(location.hash.slice(5));
    if (state.byId.has(id)) openCamera(id, true);
  }
});

// ═════════════════════════════ 2. Map Layers Setup ══════════════════════════
function buildCamSourceAndLayers(data, clusterEnabled = true) {
  for (const id of ['cam-points', 'cam-cluster-count', 'cam-clusters']) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource('cams')) map.removeSource('cams');

  map.addSource('cams', {
    type: 'geojson',
    data,
    cluster: clusterEnabled,
    clusterRadius: 28,
    clusterMaxZoom: 6,
  });

  // Clusters
  map.addLayer({
    id: 'cam-clusters',
    type: 'circle',
    source: 'cams',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': [
        'step', ['get', 'point_count'],
        '#2563eb', 25,
        '#4f46e5', 150,
        '#7c3aed', 750,
        '#db2777',
      ],
      'circle-radius': ['step', ['get', 'point_count'], 13, 25, 17, 150, 21, 750, 26],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': 'rgba(255,255,255,0.7)',
      'circle-opacity': 0.9,
    },
  });

  map.addLayer({
    id: 'cam-cluster-count',
    type: 'symbol',
    source: 'cams',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': '{point_count_abbreviated}',
      'text-font': ['Open Sans Regular'],
      'text-size': 11,
    },
    paint: { 'text-color': '#ffffff' },
  });

  // Individual camera points
  map.addLayer({
    id: 'cam-points',
    type: 'circle',
    source: 'cams',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': [
        'match', ['get', 'k'],
        1, '#22c55e', // Live video (HLS/MP4)
        0, '#38bdf8', // Snapshot
        '#f59e0b',    // Embed/other
      ],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 3.2, 7, 5, 12, 7.5],
      'circle-stroke-width': 1,
      'circle-stroke-color': '#020617',
    },
  });

  const vis = $('lyrCams').checked ? 'visible' : 'none';
  for (const id of ['cam-clusters', 'cam-cluster-count', 'cam-points']) {
    map.setLayoutProperty(id, 'visibility', vis);
  }
}

function setupMapLayers() {
  const empty = { type: 'FeatureCollection', features: [] };
  state.lastGeoJSON = empty;

  buildCamSourceAndLayers(empty, $('chkCluster').checked);

  // Selected camera highlight halo
  map.addSource('selected-cam', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'selected-cam-ring',
    type: 'circle',
    source: 'selected-cam',
    paint: {
      'circle-radius': 14,
      'circle-color': 'rgba(56, 189, 248, 0.18)',
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#facc15',
    },
  });

  // Extra OSINT sources: Earthquakes, Natural Events, Flights, Ships
  map.addSource('quakes', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'quakes-layer',
    type: 'circle',
    source: 'quakes',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'mag'], 3], 2.5, 5, 5, 11, 7, 22],
      'circle-color': ['interpolate', ['linear'], ['coalesce', ['get', 'mag'], 3], 2.5, '#f97316', 5, '#ef4444', 6.5, '#dc2626'],
      'circle-opacity': 0.75,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#fff',
    },
  });

  map.addSource('events', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'events-layer',
    type: 'circle',
    source: 'events',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 7,
      'circle-color': '#a855f7',
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#fff',
    },
  });

  map.addSource('flights', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'flights-layer',
    type: 'circle',
    source: 'flights',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 5,
      'circle-color': '#f59e0b',
      'circle-stroke-width': 1,
      'circle-stroke-color': '#000',
    },
  });
  map.addLayer({
    id: 'flights-label',
    type: 'symbol',
    source: 'flights',
    minzoom: 6,
    layout: {
      visibility: 'none',
      'text-field': ['get', 'call'],
      'text-font': ['Open Sans Regular'],
      'text-size': 10,
      'text-offset': [0, 1.1],
    },
    paint: { 'text-color': '#fde68a', 'text-halo-color': '#000', 'text-halo-width': 1 },
  });

  map.addSource('ships', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'ships-layer',
    type: 'circle',
    source: 'ships',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 4.5,
      'circle-color': '#10b981',
      'circle-stroke-width': 1,
      'circle-stroke-color': '#022c22',
    },
  });

  // Interactions
  map.on('click', 'cam-clusters', async (e) => {
    const f = e.features[0];
    const zoom = await map.getSource('cams').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom: zoom + 0.5 });
  });

  map.on('click', 'cam-points', (e) => {
    const f = e.features[0];
    openCamera(f.properties.id, false);
  });

  map.on('click', 'flights-layer', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ closeButton: true })
      .setLngLat(e.lngLat)
      .setHTML(`<div style="color:#0f172a;font-family:monospace;font-size:12px">
        <strong>✈️ ${p.call || p.hex}</strong><br/>
        Type: ${p.type || '—'} · Reg: ${p.reg || '—'}<br/>
        Alt: ${Number(p.alt).toLocaleString()} ft · GS: ${p.gs} kt<br/>
        Track: ${p.hdg}° · Hex: ${p.hex}
      </div>`)
      .addTo(map);
  });

  map.on('click', 'quakes-layer', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ closeButton: true })
      .setLngLat(e.lngLat)
      .setHTML(`<div style="color:#0f172a;font-family:monospace;font-size:12px">
        <strong>🌋 M${p.mag} Earthquake</strong><br/>
        ${p.place}<br/>
        ${new Date(p.time).toLocaleString()}
      </div>`)
      .addTo(map);
  });

  map.on('click', 'events-layer', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ closeButton: true })
      .setLngLat(e.lngLat)
      .setHTML(`<div style="color:#0f172a;font-family:monospace;font-size:12px">
        <strong>⚠️ ${p.title}</strong><br/>
        NASA EONET Active Event
      </div>`)
      .addTo(map);
  });

  for (const lyr of ['cam-clusters', 'cam-points', 'flights-layer', 'quakes-layer', 'events-layer', 'ships-layer']) {
    map.on('mouseenter', lyr, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', lyr, () => { map.getCanvas().style.cursor = ''; });
  }
}

// ═════════════════════════════ 3. Load & Filter Cameras ═════════════════════
async function loadCameraIndex() {
  $('hudStats').textContent = 'Loading camera index…';
  const r = await fetch('/api/index');
  const data = await r.json();
  state.sources = data.sources || [];
  state.cams = data.cams || [];
  state.byId.clear();
  state.enabledSrc = new Set(state.sources.map((_, i) => i));

  for (const row of state.cams) {
    state.byId.set(row[0], row);
  }

  updateCameraGeoJSON();
  renderSourcesModal();
  updateWallBadge();

  if (state.cams.length === 0) {
    $('hudStats').textContent = 'Building index from live agencies… (auto-refreshing)';
    setTimeout(loadCameraIndex, 4000);
  }
}

function updateCameraGeoJSON() {
  const features = [];
  for (const row of state.cams) {
    const [id, lon, lat, srcIdx, kind, name] = row;
    if (!state.enabledSrc.has(srcIdx)) continue;
    if (state.kindFilter === 'video' && kind !== 1) continue;
    if (state.kindFilter === 'image' && kind !== 0) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { id, s: srcIdx, k: kind, n: name },
    });
  }
  state.lastGeoJSON = { type: 'FeatureCollection', features };
  map.getSource('cams')?.setData(state.lastGeoJSON);
  const activeSrcCount = state.sources.filter((s, i) => s.count > 0 && state.enabledSrc.has(i)).length;
  $('cntCams').textContent = features.length.toLocaleString();
  $('hudStats').textContent = `${features.length.toLocaleString()} live feeds · ${activeSrcCount} agencies online`;
}

// ═════════════════════════════ 4. Camera Inspector ══════════════════════════
function stopActiveMedia() {
  if (state.activeHls) {
    try { state.activeHls.destroy(); } catch {}
    state.activeHls = null;
  }
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

async function openCamera(id, fly = false) {
  stopActiveMedia();
  state.selectedId = id;
  location.hash = `cam=${encodeURIComponent(id)}`;
  $('inspector').classList.remove('hidden');
  $('mediaStage').innerHTML = `<div class="media-placeholder">Connecting to camera ${id}…</div>`;

  const row = state.byId.get(id);
  if (row) {
    const [, lon, lat] = row;
    map.getSource('selected-cam')?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} }],
    });
    if (fly) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 12.5), speed: 1.4 });
  }

  const r = await fetch(`/api/cam?id=${encodeURIComponent(id)}`);
  if (!r.ok) {
    $('mediaStage').innerHTML = `<div class="media-placeholder">Camera metadata unavailable.</div>`;
    return;
  }
  const cam = await r.json();

  $('camTitle').textContent = cam.name || cam.id;
  $('camSub').textContent = `${cam.srcName || cam.src} · ${cam.region || cam.country || ''}`;
  $('btnRawLink').href = cam.hls || cam.mp4 || cam.img || cam.page || '#';
  $('btnGmaps').href = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${cam.lat},${cam.lon}`;
  updatePinButton();

  // Render media
  if (cam.hls) {
    $('camBadge').textContent = 'LIVE VIDEO STREAM (HLS)';
    $('refreshBar').classList.add('hidden');
    playHlsInStage(cam);
  } else if (cam.mp4) {
    $('camBadge').textContent = 'LIVE VIDEO CLIP (MP4)';
    $('refreshBar').classList.add('hidden');
    $('mediaStage').innerHTML = `<video src="${cam.mp4}?t=${Date.now()}" autoplay loop muted controls playsinline></video>`;
  } else if (cam.iframe && cam.iframe !== 'pending') {
    $('camBadge').textContent = 'EMBEDDED PLAYER';
    $('refreshBar').classList.add('hidden');
    $('mediaStage').innerHTML = `<iframe src="${cam.iframe}" allowfullscreen></iframe>`;
  } else if (cam.img) {
    $('camBadge').textContent = 'LIVE SNAPSHOT FEED';
    $('refreshBar').classList.remove('hidden');
    startSnapshotLoop(cam);
  } else if (cam.page) {
    $('camBadge').textContent = 'EXTERNAL PORTAL';
    $('refreshBar').classList.add('hidden');
    $('mediaStage').innerHTML = `<div class="media-placeholder">This camera opens on its official portal:<br/><br/><a class="primary-btn" style="padding:8px 14px" href="${cam.page}" target="_blank" rel="noopener">Open Official Stream ↗</a></div>`;
  }

  // Metadata grid
  $('camMeta').innerHTML = `
    <div class="meta-box"><div class="meta-k">COORDINATES</div><div class="meta-v">${cam.lat.toFixed(5)}, ${cam.lon.toFixed(5)}</div></div>
    <div class="meta-box"><div class="meta-k">AGENCY / SOURCE</div><div class="meta-v">${cam.srcName || cam.src} (${cam.country || ''})</div></div>
    <div class="meta-box"><div class="meta-k">DIRECTION / REGION</div><div class="meta-v">${cam.dir || 'Omni'} · ${cam.region || '—'}</div></div>
    <div class="meta-box"><div class="meta-k">NODE ID</div><div class="meta-v">${cam.id}</div></div>
  `;

  renderNearby(cam.lat, cam.lon, cam.id);
}

function playHlsInStage(cam) {
  const video = document.createElement('video');
  video.controls = true;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  $('mediaStage').innerHTML = '';
  $('mediaStage').appendChild(video);

  const proxyUrl = `/api/hls?id=${encodeURIComponent(cam.id)}`;
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true, maxBufferLength: 10 });
    state.activeHls = hls;
    let triedDirect = false;
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        if (!triedDirect && cam.hls) {
          triedDirect = true;
          hls.loadSource(cam.hls);
        } else if (cam.img) {
          // Fallback to live snapshot if HLS stream is temporarily down
          stopActiveMedia();
          $('camBadge').textContent = 'LIVE SNAPSHOT (STREAM FALLBACK)';
          $('refreshBar').classList.remove('hidden');
          startSnapshotLoop(cam);
        }
      }
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    hls.loadSource(proxyUrl);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = proxyUrl;
    video.play().catch(() => {});
  }
}

function startSnapshotLoop(cam) {
  const img = document.createElement('img');
  img.alt = cam.name;
  $('mediaStage').innerHTML = '';
  $('mediaStage').appendChild(img);

  const loadFrame = (forceFresh = false) => {
    const t = Date.now();
    const proxySrc = `/api/img?id=${encodeURIComponent(cam.id)}&t=${t}${forceFresh ? '&fresh=1' : ''}`;
    img.onerror = () => {
      if (!img.dataset.fallbackTried) {
        img.dataset.fallbackTried = '1';
        img.src = cam.img + (cam.img.includes('?') ? '&' : '?') + 't=' + t;
      }
    };
    img.onload = () => { delete img.dataset.fallbackTried; };
    img.src = proxySrc;
    $('liveStatus').textContent = `● UPDATED ${new Date().toLocaleTimeString()}`;
  };

  loadFrame();
  const applyTimer = () => {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    const ms = Number($('refreshRate').value);
    if (ms > 0) state.refreshTimer = setInterval(() => loadFrame(false), ms);
  };
  applyTimer();
  $('refreshRate').onchange = applyTimer;
  $('btnReloadImg').onclick = () => loadFrame(true);
}

function renderNearby(lat, lon, currentId) {
  const distKm = (la1, lo1, la2, lo2) => {
    const R = 6371, dLat = (la2 - la1) * Math.PI / 180, dLon = (lo2 - lo1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };
  const best = [];
  for (const row of state.cams) {
    if (row[0] === currentId) continue;
    const dLat = Math.abs(row[2] - lat), dLon = Math.abs(row[1] - lon);
    if (dLat > 1.5 || dLon > 1.5) continue;
    const d = distKm(lat, lon, row[2], row[1]);
    best.push({ row, d });
  }
  best.sort((a, b) => a.d - b.d);
  const top = best.slice(0, 8);
  $('nearbyList').innerHTML = top.map(({ row, d }) => `
    <div class="nearby-item" data-id="${row[0]}">
      <span>${row[5] || row[0]}</span>
      <span class="nearby-dist">${d < 1 ? (d * 1000).toFixed(0) + ' m' : d.toFixed(1) + ' km'}</span>
    </div>
  `).join('') || `<div class="small-lbl">No other cameras within 150 km.</div>`;

  $('nearbyList').querySelectorAll('.nearby-item').forEach((el) => {
    el.onclick = () => openCamera(el.dataset.id, true);
  });
}

// ═════════════════════════════ 5. Multi-Cam Video Wall ══════════════════════
function saveWall() {
  localStorage.setItem('argus_eyes_wall', JSON.stringify(state.wallIds));
  updateWallBadge();
}
function updateWallBadge() {
  $('wallCount').textContent = state.wallIds.length;
}
function updatePinButton() {
  const pinned = state.wallIds.includes(state.selectedId);
  $('btnPinWall').textContent = pinned ? '✓ Pinned to Wall (Remove)' : '＋ Pin to Video Wall';
}

$('btnPinWall').onclick = () => {
  if (!state.selectedId) return;
  const idx = state.wallIds.indexOf(state.selectedId);
  if (idx >= 0) state.wallIds.splice(idx, 1);
  else state.wallIds.push(state.selectedId);
  saveWall();
  updatePinButton();
};

async function openWallModal() {
  $('wallModal').classList.remove('hidden');
  await renderWallTiles();
}

function closeWallModal() {
  $('wallModal').classList.add('hidden');
  state.wallHls.forEach((h) => { try { h.destroy(); } catch {} });
  state.wallHls = [];
  if (state.wallTimer) { clearInterval(state.wallTimer); state.wallTimer = null; }
}

async function renderWallTiles() {
  state.wallHls.forEach((h) => { try { h.destroy(); } catch {} });
  state.wallHls = [];
  if (state.wallTimer) { clearInterval(state.wallTimer); state.wallTimer = null; }

  const grid = $('wallGrid');
  if (!state.wallIds.length) {
    grid.innerHTML = `<div class="media-placeholder" style="grid-column:1/-1">Your Video Wall is empty. Click <strong>"🎬 Fill 6 Live Videos"</strong> or <strong>"🎲 Fill 6 Random Cams"</strong> above, or pin any camera from the map!</div>`;
    return;
  }

  grid.innerHTML = `<div class="media-placeholder" style="grid-column:1/-1">Loading ${state.wallIds.length} pinned feeds…</div>`;
  const cams = (await Promise.all(
    state.wallIds.map((id) => fetch(`/api/cam?id=${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null))
  )).filter(Boolean);

  grid.innerHTML = '';
  const imgsToRefresh = [];

  const mountSnapLoop = (body, badgeEl, refreshBtn, cam) => {
    body.innerHTML = '';
    const im = document.createElement('img');
    im.alt = cam.name || cam.id;
    body.appendChild(im);
    refreshBtn.classList.remove('hidden');

    const load = (forceFresh = false) => {
      if (!forceFresh && im.dataset.busy === '1') return;
      im.dataset.busy = '1';
      const t = Date.now();
      im.onerror = () => {
        if (!im.dataset.fallbackTried) {
          im.dataset.fallbackTried = '1';
          im.src = cam.img + (cam.img.includes('?') ? '&' : '?') + 't=' + t;
        } else {
          delete im.dataset.busy;
        }
      };
      im.onload = () => { delete im.dataset.fallbackTried; delete im.dataset.busy; };
      im.src = `/api/img?id=${encodeURIComponent(cam.id)}&t=${t}${forceFresh ? '&fresh=1' : ''}`;
      badgeEl.className = 'wall-badge snap';
      badgeEl.textContent = `🔵 SNAP ${new Date().toLocaleTimeString([], { hour12: false })}`;
    };
    load(false);
    refreshBtn.onclick = () => load(true);
    imgsToRefresh.push(() => load(false));
  };

  for (const cam of cams) {
    const tile = document.createElement('div');
    tile.className = 'wall-tile';
    tile.innerHTML = `
      <div class="wall-tile-head">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${cam.name || cam.id} <small style="color:#94a3b8">(${cam.country || ''})</small></span>
        <span class="wall-badge">…</span>
        <div style="display:flex;gap:4px">
          <button class="mini-btn wall-refresh hidden" title="Refresh snapshot now">↻</button>
          <button class="mini-btn wall-locate" title="Fly to camera">📍</button>
          <button class="mini-btn wall-remove" title="Remove">✕</button>
        </div>
      </div>
      <div class="wall-tile-body"></div>
    `;
    grid.appendChild(tile);

    const badge = tile.querySelector('.wall-badge');
    const refreshBtn = tile.querySelector('.wall-refresh');
    const body = tile.querySelector('.wall-tile-body');

    tile.querySelector('.wall-locate').onclick = () => { closeWallModal(); openCamera(cam.id, true); };
    tile.querySelector('.wall-remove').onclick = () => {
      state.wallIds = state.wallIds.filter((x) => x !== cam.id);
      saveWall();
      renderWallTiles();
    };

    if (cam.mp4) {
      badge.className = 'wall-badge vid';
      badge.textContent = '🟢 VIDEO';
      const v = document.createElement('video');
      v.src = `${cam.mp4}?t=${Date.now()}`;
      v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true; v.controls = true;
      body.appendChild(v);
      v.play().catch(() => {});
    } else if (cam.hls && window.Hls && Hls.isSupported()) {
      badge.className = 'wall-badge vid';
      badge.textContent = '🟢 LIVE HLS';
      const v = document.createElement('video');
      v.autoplay = true; v.muted = true; v.playsInline = true; v.controls = true;
      body.appendChild(v);
      const h = new Hls({ enableWorker: true, maxBufferLength: 8 });
      state.wallHls.push(h);
      let triedDirect = false;
      h.on(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(() => {}); });
      h.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) {
          if (!triedDirect && cam.hls) {
            triedDirect = true;
            h.loadSource(cam.hls);
          } else if (cam.img) {
            try { h.destroy(); } catch {}
            mountSnapLoop(body, badge, refreshBtn, cam);
          } else {
            badge.className = 'wall-badge emb';
            badge.textContent = '⚠ OFFLINE';
          }
        }
      });
      h.loadSource(`/api/hls?id=${encodeURIComponent(cam.id)}`);
      h.attachMedia(v);
    } else if (cam.hls) {
      badge.className = 'wall-badge vid';
      badge.textContent = '🟢 LIVE HLS';
      const v = document.createElement('video');
      v.src = `/api/hls?id=${encodeURIComponent(cam.id)}`;
      v.autoplay = true; v.muted = true; v.playsInline = true; v.controls = true;
      body.appendChild(v);
      v.play().catch(() => {});
    } else if (cam.iframe && cam.iframe !== 'pending') {
      badge.className = 'wall-badge emb';
      badge.textContent = '🎬 PLAYER';
      body.innerHTML = `<iframe src="${cam.iframe}" allowfullscreen></iframe>`;
    } else if (cam.img) {
      mountSnapLoop(body, badge, refreshBtn, cam);
    } else if (cam.page) {
      badge.className = 'wall-badge emb';
      badge.textContent = '↗ PORTAL';
      body.innerHTML = `<a class="primary-btn" style="padding:8px 14px;flex:0" href="${cam.page}" target="_blank" rel="noopener">Open Official Stream ↗</a>`;
    }
  }

  const applyWallTimer = () => {
    if (state.wallTimer) { clearInterval(state.wallTimer); state.wallTimer = null; }
    const ms = Number($('wallRefreshRate').value);
    if (imgsToRefresh.length && ms > 0) {
      state.wallTimer = setInterval(() => imgsToRefresh.forEach((fn) => fn()), ms);
    }
  };
  applyWallTimer();
  $('wallRefreshRate').onchange = applyWallTimer;
}

// ═════════════════════════════ 6. Extra OSINT Layers ════════════════════════
// Flights (ADS-B around current map center)
async function refreshFlights() {
  if (!$('lyrFlights').checked) return;
  const c = map.getCenter();
  $('cntFlights').textContent = '…';
  try {
    const r = await fetch(`/api/flights?lat=${c.lat}&lon=${c.lng}&dist=250`);
    const list = await r.json();
    const features = list.map(([hex, lon, lat, hdg, alt, call, type, reg, gs]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { hex, hdg, alt, call, type, reg, gs },
    }));
    map.getSource('flights')?.setData({ type: 'FeatureCollection', features });
    $('cntFlights').textContent = features.length;
  } catch {
    $('cntFlights').textContent = 'err';
  }
}

$('lyrFlights').onchange = (e) => {
  const vis = e.target.checked ? 'visible' : 'none';
  map.setLayoutProperty('flights-layer', 'visibility', vis);
  map.setLayoutProperty('flights-label', 'visibility', vis);
  if (e.target.checked) {
    refreshFlights();
    state.flightsTimer = setInterval(refreshFlights, 10000);
  } else {
    clearInterval(state.flightsTimer);
    $('cntFlights').textContent = 'off';
  }
};
map.on('moveend', () => { if ($('lyrFlights').checked) refreshFlights(); });

// Earthquakes (USGS)
$('lyrQuakes').onchange = async (e) => {
  const vis = e.target.checked ? 'visible' : 'none';
  map.setLayoutProperty('quakes-layer', 'visibility', vis);
  if (e.target.checked) {
    $('cntQuakes').textContent = '…';
    const r = await fetch('/api/quakes');
    const gj = await r.json();
    map.getSource('quakes')?.setData(gj);
    $('cntQuakes').textContent = gj.features?.length || 0;
  } else {
    $('cntQuakes').textContent = 'off';
  }
};

// Natural Events (NASA EONET)
$('lyrEvents').onchange = async (e) => {
  const vis = e.target.checked ? 'visible' : 'none';
  map.setLayoutProperty('events-layer', 'visibility', vis);
  if (e.target.checked) {
    $('cntEvents').textContent = '…';
    const r = await fetch('/api/events');
    const gj = await r.json();
    // Normalize GeometryCollection or Polygon to Point so circle layer renders all
    const features = (gj.features || []).map((f) => {
      let coords = f.geometry?.coordinates;
      if (f.geometry?.type === 'GeometryCollection') coords = f.geometry.geometries?.[0]?.coordinates;
      if (Array.isArray(coords?.[0])) coords = coords[0][0];
      return coords ? { type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: f.properties } : null;
    }).filter(Boolean);
    map.getSource('events')?.setData({ type: 'FeatureCollection', features });
    $('cntEvents').textContent = features.length;
  } else {
    $('cntEvents').textContent = 'off';
  }
};

// Weather Radar (RainViewer)
$('lyrRadar').onchange = async (e) => {
  if (e.target.checked) {
    $('cntRadar').textContent = '…';
    const r = await fetch('/api/radar');
    const j = await r.json();
    const past = j.radar?.past || [];
    const latest = past[past.length - 1];
    if (latest) {
      if (map.getLayer('radar-layer')) map.removeLayer('radar-layer');
      if (map.getSource('radar')) map.removeSource('radar');
      map.addSource('radar', {
        type: 'raster',
        tiles: [`${j.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`],
        tileSize: 256,
      });
      map.addLayer({ id: 'radar-layer', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.6 } }, 'cam-clusters');
      $('cntRadar').textContent = 'live';
    }
  } else {
    if (map.getLayer('radar-layer')) map.removeLayer('radar-layer');
    $('cntRadar').textContent = 'off';
  }
};

// AIS Ships
async function refreshShips() {
  if (!$('lyrShips').checked) return;
  const r = await fetch('/api/ships');
  const j = await r.json();
  if (!j.enabled) {
    $('cntShips').textContent = 'add key';
    return;
  }
  const features = (j.ships || []).map(([id, lon, lat, hdg, name, sog]) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id, hdg, name, sog },
  }));
  map.getSource('ships')?.setData({ type: 'FeatureCollection', features });
  $('cntShips').textContent = j.total;
}
$('lyrShips').onchange = (e) => {
  map.setLayoutProperty('ships-layer', 'visibility', e.target.checked ? 'visible' : 'none');
  if (e.target.checked) {
    refreshShips();
    state.shipsTimer = setInterval(refreshShips, 10000);
  } else {
    clearInterval(state.shipsTimer);
    $('cntShips').textContent = 'off';
  }
};

// Camera layer visibility toggle
$('lyrCams').onchange = (e) => {
  const vis = e.target.checked ? 'visible' : 'none';
  for (const id of ['cam-clusters', 'cam-cluster-count', 'cam-points']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
  }
};

// Cluster toggle (uncheck to see all raw green & blue dots at world zoom)
$('chkCluster').onchange = (e) => {
  buildCamSourceAndLayers(state.lastGeoJSON || { type: 'FeatureCollection', features: [] }, e.target.checked);
};

// ═════════════════════════════ 7. UI Controls & Search ══════════════════════
// Basemap switcher
$('basemapSwitch').querySelectorAll('.seg').forEach((btn) => {
  btn.onclick = () => {
    $('basemapSwitch').querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const st = btn.dataset.style;
    map.setLayoutProperty('base-dark', 'visibility', st === 'dark' ? 'visible' : 'none');
    map.setLayoutProperty('base-sat', 'visibility', st === 'sat' ? 'visible' : 'none');
    map.setLayoutProperty('base-sat-lbl', 'visibility', st === 'sat' ? 'visible' : 'none');
    map.setLayoutProperty('base-street', 'visibility', st === 'street' ? 'visible' : 'none');
  };
});

// Kind filter (All / Live Video / Snapshots)
$('kindFilter').querySelectorAll('.seg').forEach((btn) => {
  btn.onclick = () => {
    $('kindFilter').querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.kindFilter = btn.dataset.kind;
    updateCameraGeoJSON();
  };
});

// Quick region chips
document.querySelectorAll('.chip[data-fly]').forEach((btn) => {
  btn.onclick = () => {
    const [lon, lat, zoom] = btn.dataset.fly.split(',').map(Number);
    map.flyTo({ center: [lon, lat], zoom, speed: 1.5 });
  };
});

// Random camera button
$('btnRandom').onclick = () => {
  const pool = state.cams.filter((c) => state.enabledSrc.has(c[3]) && (state.kindFilter === 'all' || (state.kindFilter === 'video' ? c[4] === 1 : c[4] === 0)));
  if (!pool.length) return;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  openCamera(pick[0], true);
};

// Search input
$('searchInput').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const box = $('searchResults');
  if (q.length < 2) { box.classList.add('hidden'); return; }
  const matches = [];
  for (const row of state.cams) {
    if ((row[5] || '').toLowerCase().includes(q) || row[0].toLowerCase().includes(q)) {
      matches.push(row);
      if (matches.length >= 30) break;
    }
  }
  box.innerHTML = matches.map((r) => {
    const src = state.sources[r[3]] || {};
    return `<div class="search-item" data-id="${r[0]}">
      <span class="s-name">${r[5] || r[0]}</span>
      <span class="s-meta">${r[4] === 1 ? '🟢 VIDEO' : '🔵 SNAP'} · ${src.country || ''}</span>
    </div>`;
  }).join('') || `<div class="search-item"><span class="s-meta">No matching cameras</span></div>`;
  box.classList.remove('hidden');
  box.querySelectorAll('.search-item[data-id]').forEach((el) => {
    el.onclick = () => {
      box.classList.add('hidden');
      openCamera(el.dataset.id, true);
    };
  });
});

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('searchInput')) {
    e.preventDefault();
    $('searchInput').focus();
  } else if (e.key === 'Escape') {
    $('searchResults').classList.add('hidden');
    closeWallModal();
    $('sourcesModal').classList.add('hidden');
    stopActiveMedia();
    $('inspector').classList.add('hidden');
  }
});

$('btnCloseInspector').onclick = () => { stopActiveMedia(); $('inspector').classList.add('hidden'); };

// Video Wall modal controls
$('btnWall').onclick = openWallModal;
$('btnCloseWall').onclick = closeWallModal;
$('btnWallClear').onclick = () => { state.wallIds = []; saveWall(); renderWallTiles(); };
$('btnWallRandomVideo').onclick = () => {
  const pool = state.cams.filter((c) => state.enabledSrc.has(c[3]) && c[4] === 1);
  if (!pool.length) return;
  const picks = new Set();
  while (picks.size < Math.min(6, pool.length)) {
    picks.add(pool[Math.floor(Math.random() * pool.length)][0]);
  }
  state.wallIds = [...picks];
  saveWall();
  renderWallTiles();
};
$('btnWallRandom').onclick = () => {
  const pool = state.cams.filter((c) => state.enabledSrc.has(c[3]));
  if (!pool.length) return;
  const picks = new Set();
  while (picks.size < Math.min(6, pool.length)) {
    picks.add(pool[Math.floor(Math.random() * pool.length)][0]);
  }
  state.wallIds = [...picks];
  saveWall();
  renderWallTiles();
};

// Sources modal controls
function renderSourcesModal() {
  const total = state.cams.length;
  const online = state.sources.filter((s) => s.count > 0).length;
  $('sourcesSummary').textContent = `${total.toLocaleString()} total cameras across ${online} active public agencies`;
  $('sourcesTbody').innerHTML = state.sources.map((s, idx) => `
    <tr data-idx="${idx}">
      <td><input type="checkbox" ${state.enabledSrc.has(idx) ? 'checked' : ''} /></td>
      <td><strong>${s.name}</strong></td>
      <td>${s.country} · ${s.region || ''}</td>
      <td style="font-family:monospace">${s.count.toLocaleString()}</td>
      <td style="color:${s.ok && s.count > 0 ? '#4ade80' : '#f87171'}">${s.ok && s.count > 0 ? `● Online (${s.ms}ms)` : (s.error || '0 cams')}</td>
    </tr>
  `).join('');

  $('sourcesTbody').querySelectorAll('tr').forEach((tr) => {
    tr.onclick = (e) => {
      const idx = Number(tr.dataset.idx);
      const cb = tr.querySelector('input');
      if (e.target !== cb) cb.checked = !cb.checked;
      if (cb.checked) state.enabledSrc.add(idx);
      else state.enabledSrc.delete(idx);
      updateCameraGeoJSON();
    };
  });
}

$('btnSources').onclick = () => { renderSourcesModal(); $('sourcesModal').classList.remove('hidden'); };
$('btnCloseSources').onclick = () => $('sourcesModal').classList.add('hidden');
$('btnEnableAllSrc').onclick = () => { state.enabledSrc = new Set(state.sources.map((_, i) => i)); renderSourcesModal(); updateCameraGeoJSON(); };
$('btnDisableAllSrc').onclick = () => { state.enabledSrc.clear(); renderSourcesModal(); updateCameraGeoJSON(); };
$('btnRebuildIndex').onclick = async () => {
  $('btnRebuildIndex').textContent = '⏳ Rebuilding…';
  await fetch('/api/refresh');
  setTimeout(async () => {
    await loadCameraIndex();
    $('btnRebuildIndex').textContent = '↻ Rebuild Index Now';
  }, 8000);
};
