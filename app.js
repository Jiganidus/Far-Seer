/* Travel Map — prototype
   Fog-of-war travel log. Reveals the map where you've been, logs places and sights,
   narrates what you pass, and pins photos. All data stays on this device. */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);

// ---------- Settings you can tune ----------
const CFG = {
  cellDeg: 0.0005,        // reveal grid (~55 m)
  revealM: 300,           // radius of map revealed around each point (set in Settings)
  maxAcc: 1500,           // ignore GPS fixes less accurate than this (m)
  maxGapMs: 5 * 60e3,     // gaps longer than this don't count as time spent
  maxSpeed: 70,           // m/s; faster than this (flights) reveals points, not lines
  geocodeEveryM: 350,     // check which suburb/town you're in every N metres
  poiFetchEveryM: 3000,   // refresh nearby sights every N metres
  poiNearM: 150,          // "passing" distance when walking
  poiNearFastM: 300,      // "passing" distance when driving
  poiAnnounceGapMs: 20e3, // minimum time between spoken sights
};
// Visit tiers, by total time spent in an area or near a sight
const TIERS = [
  [10 * 60e3, 'Passed by', 'var(--muted)'],
  [30 * 60e3, 'Dropped by', 'var(--blue)'],
  [24 * 3600e3, 'Stayed', 'var(--green)'],
  [30 * 24 * 3600e3, 'Travelled', 'var(--magenta)'],
  [Infinity, 'Lived', 'var(--ink)'],
];
const tierOf = (ms) => { for (const [lim, name, c] of TIERS) if (ms < lim) return { name, c }; };
const PHOTO_CATS = ['Bird', 'Animal', 'Plant', 'Landscape', 'Building', 'Food', 'Other'];

// ---------- Small helpers ----------
const R = 6371000, rad = (d) => d * Math.PI / 180;
function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  return Math.round(h / 24) + ' days';
}
const fmtDate = (t) => new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sentences(text, n) {
  const parts = String(text || '').replace(/\s*\([^)]*\)/g, '').match(/[^.!?]+[.!?]+(\s|$)/g) || [text || ''];
  return parts.slice(0, n).join('').trim();
}
async function getJSON(url, ms = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- Options (remembered on this device) ----------
const opt = { voice: true, sound: true, wake: true, theme: 'auto', reveal: 300 };
try { Object.assign(opt, JSON.parse(localStorage.getItem('tm-opt') || '{}')); } catch (e) {}
CFG.revealM = +opt.reveal || 300;
const saveOpt = () => { try { localStorage.setItem('tm-opt', JSON.stringify(opt)); } catch (e) {} };

// ---------- Storage (IndexedDB) ----------
const STORES = { cells: 'k', areas: 'key', pois: 'id', photos: 'id', meta: 'k' };
let db = null;
function openDB() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('travel-map', 1);
      req.onupgradeneeded = () => {
        for (const [name, keyPath] of Object.entries(STORES))
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
function dbAll(store) {
  return new Promise((resolve) => {
    if (!db) return resolve([]);
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}
function dbPutMany(store, items) {
  if (!db || demo || !items.length) return Promise.resolve();
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    items.forEach((it) => os.put(it));
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
}
const dbPut = (store, item) => dbPutMany(store, [item]);
function dbClearAll() {
  if (!db) return Promise.resolve();
  return new Promise((resolve) => {
    const tx = db.transaction(Object.keys(STORES), 'readwrite');
    Object.keys(STORES).forEach((s) => tx.objectStore(s).clear());
    tx.oncomplete = tx.onerror = () => resolve();
  });
}

// ---------- App state ----------
const freshState = () => ({ cells: new Set(), pts: [], areas: new Map(), pois: new Map(), photos: new Map(), meta: { distM: 0, lastLat: null, lastLng: null } });
let S = freshState();
let realS = null;          // holds the real data while a demo runs
let demo = false;
let pendingCells = [];

function addCell(lat, lng) {
  const i = Math.round(lat / CFG.cellDeg), j = Math.round(lng / CFG.cellDeg);
  const k = i + ':' + j;
  if (S.cells.has(k)) return;
  S.cells.add(k);
  S.pts.push([i * CFG.cellDeg, j * CFG.cellDeg]);
  if (!demo) pendingCells.push({ k });
  requestDraw();
}
function revealLine(a, b) {
  const steps = Math.max(1, Math.ceil(dist(a, b) / 40));
  for (let s = 0; s <= steps; s++) addCell(a.lat + (b.lat - a.lat) * s / steps, a.lng + (b.lng - a.lng) * s / steps);
}
setInterval(() => {
  if (pendingCells.length) { dbPutMany('cells', pendingCells); pendingCells = []; }
}, 2000);
const saveMeta = () => dbPut('meta', { k: 'meta', ...S.meta });

// ---------- Map ----------
const map = L.map('map', { zoomControl: false, attributionControl: true, zoomAnimation: false, worldCopyJump: true, minZoom: 2, maxZoom: 19 })
  .setView([-33.8688, 151.2093], 12);
let tiles = null;
function setTiles(dark) {
  if (tiles) map.removeLayer(tiles);
  // OpenStreetMap's own tiles (no key needed); the matte light/dark look is a CSS filter in style.css
  tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
}
const meMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 });
const poiLayer = L.layerGroup().addTo(map);
const photoLayer = L.layerGroup().addTo(map);
const photoMarkers = new Map();
let follow = true;
map.on('dragstart', () => { follow = false; });

// ---------- Fog of war ----------
const fog = $('fog');
const fctx = fog.getContext('2d');
let fogRGB = '214,213,207';
let brush = { r: 0, c: null };
function getBrush(r) {
  r = Math.max(1, Math.round(r));
  if (brush.r === r) return brush.c;
  const s = r * 2 + 2, c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, r);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.55, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, s, s);
  brush = { r, c };
  return c;
}
// faint diagonal hatching so unexplored land reads as "unknown" in both themes
let hatch = { key: '', p: null };
function getHatch(dpr) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const key = dpr + (dark ? 'd' : 'l');
  if (hatch.key === key) return hatch.p;
  const s = Math.round(14 * dpr), c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  x.strokeStyle = dark ? 'rgba(143,184,222,0.10)' : 'rgba(35,38,42,0.07)';
  x.lineWidth = dpr;
  x.beginPath(); x.moveTo(0, s); x.lineTo(s, 0); x.moveTo(-s / 2, s / 2); x.lineTo(s / 2, -s / 2); x.moveTo(s / 2, s * 1.5); x.lineTo(s * 1.5, s / 2); x.stroke();
  hatch = { key, p: fctx.createPattern(c, 'repeat') };
  return hatch.p;
}
let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawFog(); });
}
function drawFog() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  if (fog.width !== Math.round(w * dpr) || fog.height !== Math.round(h * dpr)) {
    fog.width = Math.round(w * dpr); fog.height = Math.round(h * dpr);
  }
  fctx.setTransform(1, 0, 0, 1, 0, 0);
  fctx.globalCompositeOperation = 'source-over';
  fctx.clearRect(0, 0, fog.width, fog.height);
  fctx.fillStyle = `rgba(${fogRGB},0.94)`;
  fctx.fillRect(0, 0, fog.width, fog.height);
  const hp = getHatch(dpr), o = map.getPixelBounds().min, hs = Math.round(14 * dpr);
  hp.setTransform?.(new DOMMatrix().translate(-((o.x * dpr) % hs), -((o.y * dpr) % hs)));
  fctx.fillStyle = hp;
  fctx.fillRect(0, 0, fog.width, fog.height);

  // Revealed areas are painted on a low-res mask (soft edges anyway), then cut out of the fog.
  // Keeps brush sizes small even with a 1 km radius zoomed right in.
  const c = map.getCenter(), z = map.getZoom();
  const mpp = 40075016.686 * Math.cos(rad(c.lat)) / Math.pow(2, z + 8);
  const rCss = Math.max(1.5, CFG.revealM / mpp);
  const k = Math.max(0.05, Math.min(dpr, 160 / rCss));   // mask pixels per CSS pixel
  const mw = Math.max(1, Math.ceil(w * k)), mh = Math.max(1, Math.ceil(h * k));
  if (mask.width !== mw || mask.height !== mh) { mask.width = mw; mask.height = mh; }
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.globalCompositeOperation = 'source-over';
  mctx.clearRect(0, 0, mw, mh);
  const br = getBrush(rCss * k), half = br.width / 2;
  const b = map.getBounds();
  const padLat = CFG.revealM / 111000 * 1.2, padLng = padLat / Math.max(0.2, Math.cos(rad(c.lat)));
  const s = b.getSouth() - padLat, n = b.getNorth() + padLat, wl = b.getWest() - padLng, el = b.getEast() + padLng;
  const pts = S.pts;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p[0] < s || p[0] > n || p[1] < wl || p[1] > el) continue;
    const pt = map.latLngToContainerPoint(p);
    mctx.drawImage(br, pt.x * k - half, pt.y * k - half);
  }
  fctx.globalCompositeOperation = 'destination-out';
  fctx.imageSmoothingEnabled = true;
  fctx.drawImage(mask, 0, 0, mw, mh, 0, 0, fog.width, fog.height);
}
const mask = document.createElement('canvas');
const mctx = mask.getContext('2d');
map.on('move zoom resize viewreset', requestDraw);
window.addEventListener('resize', requestDraw);

// ---------- Theme ----------
const mq = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = opt.theme === 'dark' || (opt.theme === 'auto' && mq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]').content = dark ? '#16181b' : '#ecebe6';
  fogRGB = getComputedStyle(document.documentElement).getPropertyValue('--fog').trim().replace(/\s+/g, '');
  setTiles(dark);
  requestDraw();
}
mq.addEventListener?.('change', applyTheme);

// ---------- Sound and voice ----------
let actx = null;
function chime(kind) {
  if (!opt.sound || !actx) return;
  const notes = kind === 'area' ? [523.25, 659.25, 783.99] : kind === 'tier' ? [659.25, 987.77] : [880, 1174.66];
  notes.forEach((fq, i) => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = fq;
    const t = actx.currentTime + i * 0.13;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(kind === 'area' ? 0.16 : 0.1, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(actx.destination);
    o.start(t); o.stop(t + 1);
  });
}
let voice = null;
function pickVoice() {
  const vs = window.speechSynthesis?.getVoices() || [];
  voice = vs.find((v) => v.lang === 'en-AU') || vs.find((v) => v.lang === 'en-GB') || vs.find((v) => v.lang?.startsWith('en')) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text, priority) {
  if (!opt.voice || !('speechSynthesis' in window) || !text) return;
  if (priority === 'high') speechSynthesis.cancel();
  else if (speechSynthesis.speaking || speechSynthesis.pending) return;
  const u = new SpeechSynthesisUtterance(text);
  if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-AU';
  u.rate = 1;
  setTimeout(() => speechSynthesis.speak(u), 650);
}

// ---------- Welcome card ----------
let welcomeTimer;
function showCard({ kicker, title, body, url, poi }) {
  const el = $('welcome');
  el.classList.toggle('poi', !!poi);
  $('welcomeKicker').textContent = kicker;
  $('welcomeTitle').textContent = title;
  $('welcomeBody').textContent = body || '';
  const a = $('welcomeLink');
  if (url) { a.href = url; a.hidden = false; } else a.hidden = true;
  el.hidden = false;
  clearTimeout(welcomeTimer);
  welcomeTimer = setTimeout(() => { el.hidden = true; }, 16000);
}
$('welcomeClose').onclick = () => { $('welcome').hidden = true; };

// ---------- Wikipedia stories ----------
async function wikiSummary(title) {
  const j = await getJSON('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
  if (!j || j.type === 'disambiguation' || !j.extract) return null;
  return { title: j.title, story: sentences(j.extract, 3), url: j.content_urls?.mobile?.page || j.content_urls?.desktop?.page };
}
async function areaStory(area, wikiTag) {
  try {
    let title = null;
    if (wikiTag && /^en:/.test(wikiTag)) title = wikiTag.slice(3);
    if (!title) {
      const q = encodeURIComponent(`${area.name} ${area.state || area.country}`);
      const j = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&srlimit=3&format=json&origin=*`);
      const hit = (j.query?.search || []).find((h) => h.title.toLowerCase().startsWith(area.name.toLowerCase()));
      title = hit?.title;
    }
    return title ? await wikiSummary(title) : null;
  } catch (e) { return null; }
}

// ---------- Areas (suburbs, towns) ----------
let curAreaKey = null;
let geoBusy = false, lastGeoPt = null, lastGeoCall = 0, geoBackoffUntil = 0;
const narratedThisSession = new Set();

async function maybeGeocode(f) {
  const now = Date.now();
  if (geoBusy || now < geoBackoffUntil || now - lastGeoCall < 1100) return;
  if (lastGeoPt && dist(lastGeoPt, f) < CFG.geocodeEveryM) return;
  geoBusy = true; lastGeoCall = now;
  try {
    const j = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${f.lat.toFixed(5)}&lon=${f.lng.toFixed(5)}&zoom=14&addressdetails=1&extratags=1&accept-language=en`);
    lastGeoPt = { lat: f.lat, lng: f.lng };
    const a = j.address || {};
    const name = a.suburb || a.town || a.village || a.city_district || a.city || a.hamlet || a.municipality || a.county || j.name;
    if (!name) return;
    const area = { name, state: a.state || a.region || '', country: a.country || '' };
    area.key = [area.name, area.state, area.country].join('|').toLowerCase();
    const wikiTag = j.name === name ? j.extratags?.wikipedia : null;
    enterArea(area, wikiTag, last || f);
  } catch (e) {
    geoBackoffUntil = Date.now() + 15000;
  } finally { geoBusy = false; }
}

async function enterArea(area, wikiTag, f) {
  if (area.key === curAreaKey) return;
  curAreaKey = area.key;
  let rec = S.areas.get(area.key);
  const isNew = !rec;
  const newCountry = isNew && area.country && ![...S.areas.values()].some((r) => r.country === area.country);
  const newState = isNew && area.state && ![...S.areas.values()].some((r) => r.state === area.state);
  if (isNew) {
    rec = { ...area, lat: f.lat, lng: f.lng, firstSeen: f.t, lastSeen: f.t, ms: 0, visits: 0 };
    S.areas.set(area.key, rec);
  }
  rec.visits++;
  rec.lastSeen = f.t;
  dbPut('areas', rec);
  updateChip();

  const kicker = newCountry ? `New country · ${area.country}` : newState ? `New state · ${area.state}` : isNew ? 'New area discovered' : 'Welcome back';
  if (!isNew && narratedThisSession.has(area.key)) { toast(`Back in ${area.name}`); return; }
  narratedThisSession.add(area.key);
  chime('area');
  showCard({ kicker, title: area.name, body: rec.story || 'Looking up the local story…', url: rec.url });

  if (!rec.story) {
    const s = await areaStory(area, wikiTag);
    if (s) { rec.story = s.story; rec.url = s.url; rec.wikiTitle = s.title; dbPut('areas', rec); }
  }
  if (curAreaKey !== area.key) return; // moved on already
  showCard({ kicker, title: area.name, body: rec.story || `${area.name}${area.state ? ', ' + area.state : ''}.`, url: rec.url });
  const lead = isNew ? `Welcome to ${area.name}.` : `Welcome back to ${area.name}.`;
  speak(`${lead} ${rec.story ? sentences(rec.story, 2) : ''}`, 'high');
}

// ---------- Sights (Wikipedia places nearby) ----------
let nearby = [], lastPoiPt = null, poiBusy = false, lastAnnounce = -Infinity;
const nearNow = new Set();
async function maybePois(f) {
  if (poiBusy || (lastPoiPt && dist(lastPoiPt, f) < CFG.poiFetchEveryM)) return;
  poiBusy = true;
  try {
    const j = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${f.lat.toFixed(5)}|${f.lng.toFixed(5)}&gsradius=10000&gslimit=300&format=json&origin=*`);
    lastPoiPt = { lat: f.lat, lng: f.lng };
    nearby = (j.query?.geosearch || []).map((p) => ({ id: 'w' + p.pageid, title: p.title, lat: p.lat, lng: p.lon }));
  } catch (e) { /* offline: try again next time we move */ }
  finally { poiBusy = false; }
}
const isAreaArticle = (title) => {
  if (/^List of /i.test(title)) return true;
  for (const r of S.areas.values()) {
    if (r.wikiTitle === title) return true;
    if (r.state && title.endsWith(', ' + r.state) && title.toLowerCase().startsWith(r.name.toLowerCase())) return true;
  }
  return false;
};
function checkPois(f) {
  nearNow.clear();
  const radius = (f.speed || 0) > 8 ? CFG.poiNearFastM : CFG.poiNearM;
  let best = null;
  for (const p of nearby) {
    const d = dist(f, p);
    if (d > radius) continue;
    if (isAreaArticle(p.title)) continue;
    nearNow.add(p.id);
    const rec = S.pois.get(p.id);
    if (rec) { rec.lastSeen = f.t; continue; }
    if (!best || d < best.d) best = { p, d };
    const nrec = { ...p, firstSeen: f.t, lastSeen: f.t, ms: 0, area: S.areas.get(curAreaKey)?.name || '' };
    S.pois.set(p.id, nrec);
    dbPut('pois', nrec);
    addPoiMarker(nrec);
  }
  if (best && performance.now() - lastAnnounce > CFG.poiAnnounceGapMs) {
    lastAnnounce = performance.now();
    announcePoi(S.pois.get(best.p.id), f);
  }
}
function sideOf(f, p) {
  if (heading == null) return 'Nearby';
  const rel = (bearing(f, p) - heading + 360) % 360;
  if (rel < 35 || rel > 325) return 'Ahead';
  if (rel < 145) return 'On your right';
  if (rel > 215) return 'On your left';
  return 'Just behind you';
}
async function announcePoi(rec, f) {
  const side = sideOf(f, rec);
  chime('poi');
  showCard({ kicker: side, title: rec.title, body: 'Looking it up…', poi: true });
  try {
    const s = await wikiSummary(rec.title);
    if (s) { rec.story = s.story; rec.url = s.url; dbPut('pois', rec); }
  } catch (e) {}
  showCard({ kicker: side, title: rec.title, body: rec.story || '', url: rec.url, poi: true });
  speak(`${side === 'Nearby' ? 'Nearby' : side}, ${rec.title}. ${rec.story ? sentences(rec.story, 1) : ''}`);
}
function addPoiMarker(rec) {
  L.marker([rec.lat, rec.lng], { icon: L.divIcon({ className: '', html: '<div class="pin-poi"></div>', iconSize: [12, 12] }) })
    .bindPopup(() => `<div class="pop-title">${esc(rec.title)}</div><div class="pop-sub">${esc(tierOf(rec.ms).name)} · ${fmtDate(rec.firstSeen)}</div>${rec.story ? `<p>${esc(rec.story)}</p>` : ''}${rec.url ? `<a href="${esc(rec.url)}" target="_blank" rel="noopener">Wikipedia</a>` : ''}`)
    .addTo(poiLayer);
}

// ---------- Location handling ----------
let last = null, heading = null, watchId = null, exploring = false;
function credit(dt, f) {
  const a = S.areas.get(curAreaKey);
  if (a) {
    const before = tierOf(a.ms).name;
    a.ms += dt; a.lastSeen = f.t;
    const after = tierOf(a.ms).name;
    if (after !== before) { chime('tier'); toast(`${a.name}: now “${after}”`, 4500); }
    if (Math.random() < 0.1) dbPut('areas', a);
  }
  for (const id of nearNow) {
    const p = S.pois.get(id);
    if (p) { p.ms += dt; if (Math.random() < 0.1) dbPut('pois', p); }
  }
}
function handleFix(f) {
  const ll = [f.lat, f.lng];
  if (!map.hasLayer(meMarker)) meMarker.addTo(map);
  meMarker.setLatLng(ll);
  if (follow) {
    if (!last) map.setView(ll, 15);
    else map.panTo(ll, { animate: false });
  }
  if (f.acc > CFG.maxAcc) { updateChip(`Weak GPS signal (±${Math.round(f.acc)} m). Try near a window or outside`); return; }
  // Rough fix (typical indoors): still work out which suburb you're in, but don't reveal the wrong patch of map
  if (f.acc > Math.max(100, CFG.revealM)) { maybeGeocode(f); updateChip(`Rough GPS (±${Math.round(f.acc)} m). Map reveals once it sharpens`); return; }
  const prev = last;
  last = f;
  if (prev) {
    const d = dist(prev, f), dt = f.t - prev.t;
    if (dt > 0 && dt < CFG.maxGapMs && d / (dt / 1000) < CFG.maxSpeed) {
      revealLine(prev, f);
      if (d > Math.max(4, f.acc)) S.meta.distM += d; // ignore GPS wobble
      credit(dt, f);
      if (f.speed == null) f.speed = d / (dt / 1000);
    } else addCell(f.lat, f.lng);
    if (d > 8) heading = bearing(prev, f);
  } else addCell(f.lat, f.lng);
  S.meta.lastLat = f.lat; S.meta.lastLng = f.lng;
  maybeGeocode(f);
  maybePois(f);
  checkPois(f);
  updateChip();
}
setInterval(() => { if (exploring || demo) saveMeta(); }, 10000);

function updateChip(msg) {
  const a = S.areas.get(curAreaKey);
  $('liveDot').classList.toggle('on', exploring || demo);
  if (!(exploring || demo)) {
    $('areaName').textContent = S.areas.size ? `${S.areas.size} places discovered` : 'Not exploring yet';
    $('areaSub').textContent = 'Tap Explore to start revealing the map';
    return;
  }
  $('areaName').textContent = a ? a.name : 'Finding where you are…';
  $('areaSub').textContent = msg || (a ? `${tierOf(a.ms).name} · ${fmtDur(a.ms)} here · ${(S.meta.distM / 1000).toFixed(1)} km explored` : 'Getting your location');
}

// ---------- Explore on/off ----------
let wakeLock = null;
async function lockScreen() {
  if (!opt.wake || !('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (exploring || demo)) lockScreen();
  if (document.visibilityState === 'hidden') { saveMeta(); flushAll(); }
});
function unlockAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    actx.resume();
  } catch (e) {}
  if ('speechSynthesis' in window && opt.voice) {
    const u = new SpeechSynthesisUtterance(demo ? 'Starting the demo drive.' : "Let's explore.");
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  }
}
function setExploreUI() {
  const on = exploring || demo;
  $('exploreBtn').classList.toggle('on', on);
  $('exploreLabel').textContent = demo ? 'Stop demo' : exploring ? 'Exploring' : 'Explore';
  updateChip();
}
function startExplore() {
  if (!('geolocation' in navigator)) { toast('This browser has no location access.'); return; }
  exploring = true; follow = true;
  unlockAudio();
  lockScreen();
  setExploreUI();
  watchId = navigator.geolocation.watchPosition(
    (p) => handleFix({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, speed: p.coords.speed, t: Date.now() }),
    (err) => {
      if (err.code === 1) { toast('Location is blocked. Allow it for this site in your browser settings.', 6000); stopExplore(); }
      else updateChip('Still looking for GPS…');
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}
function stopExplore() {
  exploring = false;
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null; last = null; curAreaKey = null;
  wakeLock?.release?.(); wakeLock = null;
  flushAll(); saveMeta();
  setExploreUI();
}
function flushAll() {
  dbPutMany('areas', [...S.areas.values()]);
  dbPutMany('pois', [...S.pois.values()]);
}
$('exploreBtn').onclick = () => {
  if (demo) return endDemo();
  exploring ? stopExplore() : startExplore();
};
$('locateBtn').onclick = () => {
  follow = true;
  if (last) map.setView([last.lat, last.lng], Math.max(map.getZoom(), 14));
  else if (!exploring) toast('Tap Explore to find your location');
};

// ---------- Demo drive ----------
const DEMO_ROUTE = [
  [-33.8613, 151.2105], [-33.8597, 151.2128], [-33.8588, 151.2147], [-33.8620, 151.2160], [-33.8645, 151.2167],
  [-33.8688, 151.2174], [-33.8712, 151.2131], [-33.8735, 151.2112], [-33.8765, 151.2100], [-33.8800, 151.2085],
  [-33.8832, 151.2070], [-33.8857, 151.2108], [-33.8880, 151.2118], [-33.8925, 151.2045], [-33.8945, 151.1985],
  [-33.8962, 151.1918], [-33.8968, 151.1850], [-33.8973, 151.1790], [-33.8985, 151.1745],
];
let demoTimer = null;
function startDemo() {
  if (exploring) stopExplore();
  if (pendingCells.length) { dbPutMany('cells', pendingCells); pendingCells = []; }
  flushAll(); saveMeta();
  realS = S; S = freshState(); demo = true;
  curAreaKey = null; last = null; heading = null; nearby = []; lastPoiPt = null; lastGeoPt = null; narratedThisSession.clear();
  renderMarkers(); requestDraw();
  follow = true;
  unlockAudio();
  lockScreen();
  setExploreUI();
  closeSheets();
  // build the path: ~30 m steps, 2 simulated seconds each (~54 km/h), then linger at the end
  const path = [];
  for (let i = 0; i < DEMO_ROUTE.length - 1; i++) {
    const a = { lat: DEMO_ROUTE[i][0], lng: DEMO_ROUTE[i][1] }, b = { lat: DEMO_ROUTE[i + 1][0], lng: DEMO_ROUTE[i + 1][1] };
    const n = Math.max(1, Math.round(dist(a, b) / 30));
    for (let s = 0; s < n; s++) path.push([a.lat + (b.lat - a.lat) * s / n, a.lng + (b.lng - a.lng) * s / n, 2000]);
  }
  const end = DEMO_ROUTE[DEMO_ROUTE.length - 1];
  for (let s = 0; s < 14; s++) path.push([end[0] + (s % 2) * 0.00002, end[1], 90000]); // linger ~20 minutes
  let i = 0, t = Date.now();
  demoTimer = setInterval(() => {
    if (i >= path.length) { endDemo(true); return; }
    const [lat, lng, step] = path[i++];
    t += step;
    handleFix({ lat, lng, acc: 10, speed: step > 2000 ? 0 : 15, t });
  }, 450);
}
function endDemo(finished) {
  clearInterval(demoTimer); demoTimer = null;
  window.speechSynthesis?.cancel?.();
  const summary = `Demo: ${S.areas.size} places, ${S.pois.size} sights, ${(S.meta.distM / 1000).toFixed(1)} km`;
  demo = false; S = realS || freshState(); realS = null;
  curAreaKey = null; last = null; heading = null; nearby = []; lastPoiPt = null; lastGeoPt = null; narratedThisSession.clear();
  wakeLock?.release?.(); wakeLock = null;
  map.removeLayer(meMarker);
  renderMarkers(); requestDraw(); setExploreUI();
  $('welcome').hidden = true;
  toast((finished ? 'Demo finished. ' : 'Demo stopped. ') + summary + '. Your real map is back.', 6000);
}
$('demoBtn').onclick = startDemo;

// ---------- Photos ----------
const urlCache = new Map();
const photoURL = (p) => {
  if (!urlCache.has(p.id)) urlCache.set(p.id, p.blob ? URL.createObjectURL(p.blob) : p.dataUrl);
  return urlCache.get(p.id);
};
function addPhotoMarker(p) {
  const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: `<div class="pin-photo"><img src="${photoURL(p)}" alt=""></div>`, iconSize: [40, 40] }) })
    .bindPopup(() => `<img class="pop-img" src="${photoURL(p)}" alt=""><div class="pop-title">${esc(p.cat)}${p.note ? ' · ' + esc(p.note) : ''}</div><div class="pop-sub">${esc(p.area || '')}${p.area ? ' · ' : ''}${fmtDate(p.t)}</div>`)
    .addTo(photoLayer);
  photoMarkers.set(p.id, m);
}
function renderMarkers() {
  poiLayer.clearLayers(); photoLayer.clearLayers(); photoMarkers.clear();
  S.pois.forEach(addPoiMarker);
  S.photos.forEach(addPhotoMarker);
}
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
}
function currentSpot() {
  return new Promise((resolve) => {
    if (last && Date.now() - last.t < 10 * 60e3 && !demo) return resolve({ lat: last.lat, lng: last.lng });
    if (demo && last) return resolve({ lat: last.lat, lng: last.lng });
    const fallback = () => { const c = map.getCenter(); resolve({ lat: c.lat, lng: c.lng }); };
    if (!navigator.geolocation) return fallback();
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), fallback, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
}
let draft = null;
$('photoInput').onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const [blob, spot] = await Promise.all([shrink(file), currentSpot()]);
    draft = { blob, ...spot, cat: 'Other' };
    if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
    draft.previewUrl = URL.createObjectURL(blob);
    $('photoPreview').src = draft.previewUrl;
    $('photoNote').value = '';
    renderCats();
    openSheet('photoSheet');
  } catch (err) { toast("Couldn't read that photo."); }
};
function renderCats() {
  $('photoCats').innerHTML = PHOTO_CATS.map((c) => `<button class="cat${draft?.cat === c ? ' on' : ''}" data-cat="${c}">${c}</button>`).join('');
}
$('photoCats').onclick = (e) => {
  const c = e.target.closest('[data-cat]');
  if (c && draft) { draft.cat = c.dataset.cat; renderCats(); }
};
$('photoSave').onclick = () => {
  if (!draft) return;
  const p = { id: 'p' + Date.now(), blob: draft.blob, lat: draft.lat, lng: draft.lng, cat: draft.cat, note: $('photoNote').value.trim(), t: Date.now(), area: S.areas.get(curAreaKey)?.name || '' };
  S.photos.set(p.id, p);
  dbPut('photos', p);
  addPhotoMarker(p);
  addCell(p.lat, p.lng);
  draft = null;
  closeSheets();
  map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15));
  toast(demo ? 'Photo pinned (demo only, not saved)' : 'Photo pinned to your map');
};

// ---------- Sheets ----------
function openSheet(id) { closeSheets(); $(id).hidden = false; }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; }); }
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeSheets; });
map.on('click', closeSheets);

let tab = 'areas';
function renderLog() {
  const km = (S.meta.distM / 1000);
  $('stats').innerHTML = [
    [S.areas.size, 'Places'], [S.pois.size, 'Sights'], [S.photos.size, 'Photos'], [km < 100 ? km.toFixed(1) : Math.round(km), 'km'],
  ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
  const body = $('tabBody');
  const chip = (ms) => { const t = tierOf(ms); return `<span class="tier" style="--c:${t.c}">${t.name}</span>`; };
  if (tab === 'areas') {
    const list = [...S.areas.values()].sort((a, b) => b.lastSeen - a.lastSeen);
    body.innerHTML = list.length ? list.map((a) => `<div class="item" data-lat="${a.lat}" data-lng="${a.lng}"><div class="item-main"><b>${esc(a.name)}</b><small>${esc([a.state, a.country].filter(Boolean).join(', '))} · ${fmtDur(a.ms)} · since ${fmtDate(a.firstSeen)}</small></div>${chip(a.ms)}</div>`).join('')
      : '<div class="empty">No places yet. Tap Explore and go for a walk or drive.</div>';
  } else if (tab === 'pois') {
    const list = [...S.pois.values()].sort((a, b) => b.lastSeen - a.lastSeen);
    body.innerHTML = list.length ? list.map((p) => `<div class="item" data-lat="${p.lat}" data-lng="${p.lng}"><div class="item-main"><b>${esc(p.title)}</b><small>${esc(p.area || '')}${p.area ? ' · ' : ''}${fmtDate(p.firstSeen)}</small></div>${chip(p.ms)}</div>`).join('')
      : '<div class="empty">Landmarks you pass will appear here.</div>';
  } else {
    const list = [...S.photos.values()].sort((a, b) => b.t - a.t);
    body.innerHTML = list.length ? '<div class="thumbs">' + list.map((p) => `<figure data-photo="${p.id}" data-lat="${p.lat}" data-lng="${p.lng}"><img src="${photoURL(p)}" alt=""><figcaption>${esc(p.cat)}</figcaption></figure>`).join('') + '</div>'
      : '<div class="empty">Tap Photo to pin a bird, animal or sight to the map.</div>';
  }
}
document.querySelector('.tabs').onclick = (e) => { const t = e.target.closest('[data-tab]'); if (t) { tab = t.dataset.tab; renderLog(); } };
$('tabBody').onclick = (e) => {
  const it = e.target.closest('[data-lat]');
  if (!it) return;
  follow = false;
  closeSheets();
  map.setView([+it.dataset.lat, +it.dataset.lng], 15);
  if (it.dataset.photo) photoMarkers.get(it.dataset.photo)?.openPopup();
};
$('logBtn').onclick = () => { renderLog(); openSheet('logSheet'); };
$('areaChip').onclick = () => { renderLog(); openSheet('logSheet'); };
$('settingsBtn').onclick = () => openSheet('settingsSheet');

// ---------- Settings ----------
$('optVoice').checked = opt.voice; $('optSound').checked = opt.sound; $('optWake').checked = opt.wake; $('optTheme').value = opt.theme;
$('optVoice').onchange = (e) => { opt.voice = e.target.checked; if (!opt.voice) window.speechSynthesis?.cancel?.(); saveOpt(); };
$('optSound').onchange = (e) => { opt.sound = e.target.checked; saveOpt(); };
$('optWake').onchange = (e) => { opt.wake = e.target.checked; saveOpt(); if (!opt.wake) { wakeLock?.release?.(); wakeLock = null; } else if (exploring) lockScreen(); };
$('optTheme').onchange = (e) => { opt.theme = e.target.value; saveOpt(); applyTheme(); };
$('optReveal').value = String(CFG.revealM);
$('optReveal').onchange = (e) => { opt.reveal = +e.target.value; CFG.revealM = opt.reveal; saveOpt(); requestDraw(); };

const blobToDataURL = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
$('exportBtn').onclick = async () => {
  if (demo) { toast('Stop the demo first'); return; }
  flushAll();
  const photos = [];
  for (const p of S.photos.values()) { const { blob, ...rest } = p; photos.push({ ...rest, dataUrl: blob ? await blobToDataURL(blob) : p.dataUrl }); }
  const data = { app: 'travel-map', version: 1, exportedAt: new Date().toISOString(), cells: [...S.cells], areas: [...S.areas.values()], pois: [...S.pois.values()], photos, meta: S.meta };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `travel-map-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  toast('Backup saved');
};
$('importInput').onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || demo) return;
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'travel-map') throw new Error('not a backup');
    const photos = [];
    for (const p of d.photos || []) {
      const blob = p.dataUrl ? await (await fetch(p.dataUrl)).blob() : null;
      const { dataUrl, ...rest } = p;
      photos.push({ ...rest, blob });
    }
    await dbPutMany('cells', (d.cells || []).map((k) => ({ k })));
    await dbPutMany('areas', d.areas || []);
    await dbPutMany('pois', d.pois || []);
    await dbPutMany('photos', photos);
    if (d.meta) await dbPut('meta', { k: 'meta', ...S.meta, distM: Math.max(S.meta.distM, d.meta.distM || 0) });
    toast('Restored. Reloading…');
    setTimeout(() => location.reload(), 800);
  } catch (err) { toast("That file isn't a Travel Map backup."); }
};
$('clearBtn').onclick = () => {
  $('confirmText').textContent = 'Erase your whole map, places, sights and photos from this phone? This cannot be undone unless you have a backup.';
  $('confirm').hidden = false;
};
$('confirmNo').onclick = () => { $('confirm').hidden = true; };
$('confirmYes').onclick = async () => {
  $('confirm').hidden = true;
  if (exploring) stopExplore();
  await dbClearAll();
  try { localStorage.removeItem('tm-opt'); } catch (e) {}
  location.reload();
};

// ---------- Start up ----------
(async () => {
  applyTheme();
  db = await openDB();
  if (!db) toast('Storage is unavailable here, so nothing will be saved.', 5000);
  const [cells, areas, pois, photos, meta] = await Promise.all(['cells', 'areas', 'pois', 'photos', 'meta'].map(dbAll));
  for (const { k } of cells) {
    if (S.cells.has(k)) continue;
    S.cells.add(k);
    const [i, j] = k.split(':').map(Number);
    S.pts.push([i * CFG.cellDeg, j * CFG.cellDeg]);
  }
  areas.forEach((a) => S.areas.set(a.key, a));
  pois.forEach((p) => S.pois.set(p.id, p));
  photos.forEach((p) => S.photos.set(p.id, p));
  const m = meta.find((x) => x.k === 'meta');
  if (m) { delete m.k; Object.assign(S.meta, m); }
  if (S.meta.lastLat != null) map.setView([S.meta.lastLat, S.meta.lastLng], 14);
  renderMarkers();
  requestDraw();
  updateChip();
})();

// expose for testing
window.__tm = { handleFix, get S() { return S; }, map, CFG, tierOf, enterArea };
})();
