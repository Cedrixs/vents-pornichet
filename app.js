/* =============================================================================
   Vents Pornichet — application (vanilla JS, aucune dépendance externe)

   Données : réseau windmorbihan (capteur LCJ du feu du port, nid 8).
   Les valeurs de vent sont corrigées de -1 nœud pour se rapprocher du relevé
   officiel GlissEvolution. Cette correction est une approximation assumée
   (l'écart réel varie selon les conditions) — voir README.
   ========================================================================== */
'use strict';

/* ---------------------------------------------------------------------------
   1. Configuration
   ------------------------------------------------------------------------ */

const APP_VERSION = 'v1.0.0';

/** Spots suivis. Ajouter une entrée suffit pour proposer un nouveau spot. */
const SPOTS = {
  pornichet: { label: 'Pornichet', windmorbihanNid: 8 },
  // autres spots ici plus tard, même structure
};

const DEFAULT_SPOT = 'pornichet';

const CONFIG = {
  liveUrl:     'https://private2.windmorbihan.com/mesures/getlastalljson.json',
  historyUrl:  'https://private2.windmorbihan.com/mesures/history.json',

  /** Correction appliquée à la moyenne et à la rafale (en nœuds). */
  correctionKnots: 1,

  liveRefreshMs:    5 * 60 * 1000,   // rafraîchissement auto du relevé live
  historyTtlMs:    20 * 60 * 1000,   // durée de vie du cache local d'historique
  historyDepthDays: 5,               // profondeur réellement servie par la source

  nativeStepMin: 10,                 // résolution native de l'historique
  freshWarnMs:   30 * 60 * 1000,     // au-delà : relevé signalé comme ancien
  freshStaleMs: 120 * 60 * 1000,     // au-delà : considéré comme indisponible

  fetchTimeoutMs: 45 * 1000,
};

const CARDINALS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSO','SO','OSO','O','ONO','NO','NNO'];

const HOUR = 3600 * 1000;
const DAY  = 24 * HOUR;

/* ---------------------------------------------------------------------------
   2. Utilitaires
   ------------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);

/** Number() tolérant : renvoie null pour tout ce qui n'est pas un nombre fini. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Correction officielle : valeur affichée = round(valeur_source - 1), jamais négative. */
function correct(v) {
  return v === null ? null : Math.max(0, Math.round(v - CONFIG.correctionKnots));
}

/** Normalise un timestamp source (secondes ou millisecondes) en millisecondes. */
function normTs(v) {
  const n = num(v);
  if (n === null) return null;
  const ms = n > 1e12 ? n : n * 1000;
  // Garde-fou : entre 2020 et demain.
  if (ms < 1577836800000 || ms > Date.now() + DAY) return null;
  return ms;
}

function cardinal(deg) {
  if (deg === null) return '';
  return CARDINALS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

function fmtKt(v) {
  if (v === null || v === undefined) return '–';
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ',');
}

const fmtHm      = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtDayHm   = (t) => new Date(t).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDayFull = (t) => new Date(t).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** "à l'instant" / "il y a 12 min" / "il y a 3 h 05" */
function relTime(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  const r = String(min % 60).padStart(2, '0');
  if (h < 24) return `il y a ${h} h ${r}`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

/** Date -> "YYYY-MM-DDTHH:mm" en heure locale (format de <input type=datetime-local>). */
function toLocalInput(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fromLocalInput(str) {
  if (!str) return null;
  const t = new Date(str).getTime();
  return Number.isFinite(t) ? t : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.fetchTimeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------------
   3. Couche données — parsing, correction, cache local
   ------------------------------------------------------------------------ */

/**
 * Construit un point normalisé et **déjà corrigé** à partir d'un enregistrement
 * source. Renvoie null si l'enregistrement est inexploitable.
 */
function toPoint(rec, fallbackTs) {
  if (!rec || typeof rec !== 'object') return null;

  let t = normTs(rec.ts);
  if (t === null && rec.created && typeof rec.created === 'object') {
    // Relevé live : la clé de `created` est le timestamp unix du relevé.
    for (const k of Object.keys(rec.created)) {
      const c = normTs(k);
      if (c !== null && (t === null || c > t)) t = c;
    }
  }
  if (t === null && rec.timeline_heure) t = normTs(rec.timeline_heure.timestamp);
  if (t === null) t = normTs(fallbackTs);
  if (t === null) return null;

  const avg = correct(num(rec.wind_pow_knot));
  const max = correct(num(rec.wind_pow_knot_max));
  const rawDir = num(rec.wind_dir_true);
  if (avg === null && max === null) return null;

  return { t, avg, max, dir: rawDir === null ? null : ((rawDir % 360) + 360) % 360 };
}

/** Relevé live : tableau de tous les capteurs du réseau -> le nôtre. */
function parseLive(raw, nid) {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  const hits = list.filter((e) => e && typeof e === 'object' && Number(e.nid) === Number(nid));
  if (!hits.length) return null;
  const pts = hits.map((e) => toPoint(e)).filter(Boolean).sort((a, b) => a.t - b.t);
  return pts.length ? pts[pts.length - 1] : null;
}

/**
 * Historique : objet { "<ts>": { "<nid>": {...}, ... }, ... }.
 * Le endpoint a été observé renvoyant **toutes les stations** malgré ?nid=8,
 * on filtre donc systématiquement côté client.
 */
function parseHistory(raw, nid) {
  if (!raw || typeof raw !== 'object') return [];
  const key = String(nid);
  const byTs = new Map();

  for (const [outerKey, bucket] of Object.entries(raw)) {
    if (!bucket || typeof bucket !== 'object') continue;

    let rec = null;
    if (Object.prototype.hasOwnProperty.call(bucket, key)) {
      rec = bucket[key];                               // cas nominal : bucket par nid
    } else if (Number(bucket.nid) === Number(nid)) {
      rec = bucket;                                    // repli : source déjà filtrée
    }

    const p = toPoint(rec, outerKey);
    if (p) byTs.set(p.t, p);
  }

  const cutoff = Date.now() - (CONFIG.historyDepthDays + 3) * DAY;
  return [...byTs.values()]
    .filter((p) => p.t >= cutoff && p.t <= Date.now() + HOUR)
    .sort((a, b) => a.t - b.t);
}

/* --- Cache local : évite de retélécharger les ~6 Mo à chaque visite --------- */

const cacheKey = (kind, nid) => `vp.${kind}.v1.c${CONFIG.correctionKnots}.${nid}`;

function readCache(kind, nid) {
  try {
    const raw = localStorage.getItem(cacheKey(kind, nid));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

function writeCache(kind, nid, payload) {
  try {
    localStorage.setItem(cacheKey(kind, nid), JSON.stringify(payload));
  } catch { /* quota plein ou stockage indisponible : le cache est optionnel */ }
}

/** Points stockés en tableaux compacts [tsSec, avg, max, dir] pour limiter la taille. */
const packPoints   = (pts) => pts.map((p) => [Math.round(p.t / 1000), p.avg, p.max, p.dir === null ? null : Math.round(p.dir)]);
const unpackPoints = (arr) => (Array.isArray(arr) ? arr : [])
  .map(([s, avg, max, dir]) => ({ t: s * 1000, avg: num(avg), max: num(max), dir: num(dir) }))
  .filter((p) => Number.isFinite(p.t));

/* --- Chargement ------------------------------------------------------------ */

async function loadLive(nid) {
  const raw = await fetchJson(CONFIG.liveUrl);
  const point = parseLive(raw, nid);
  if (!point) throw new Error(`Capteur nid=${nid} absent du relevé`);
  writeCache('live', nid, { savedAt: Date.now(), point });
  return point;
}

async function loadHistory(nid, { force = false } = {}) {
  const cached = readCache('hist', nid);
  if (!force && cached && Date.now() - (cached.savedAt || 0) < CONFIG.historyTtlMs) {
    const pts = unpackPoints(cached.points);
    if (pts.length) return { points: pts, fromCache: true, savedAt: cached.savedAt };
  }

  try {
    const url = `${CONFIG.historyUrl}?nid=${encodeURIComponent(nid)}`;
    const points = parseHistory(await fetchJson(url), nid);
    if (!points.length) throw new Error('Historique vide');
    writeCache('hist', nid, { savedAt: Date.now(), points: packPoints(points) });
    return { points, fromCache: false, savedAt: Date.now() };
  } catch (err) {
    // Réseau HS : mieux vaut un cache périmé que rien du tout.
    const pts = cached ? unpackPoints(cached.points) : [];
    if (pts.length) return { points: pts, fromCache: true, stale: true, savedAt: cached.savedAt };
    throw err;
  }
}

/* ---------------------------------------------------------------------------
   4. Agrégation
   ------------------------------------------------------------------------ */

/**
 * Regroupe les points bruts (déjà corrigés) par intervalle de `stepMin` minutes.
 * - moyenne  : moyenne simple des moyennes
 * - rafale   : **max** des rafales de l'intervalle (ne pas lisser les pics)
 * - direction: moyenne vectorielle (circulaire)
 */
function aggregate(points, stepMin) {
  if (!stepMin || stepMin <= CONFIG.nativeStepMin) return points;
  const span = stepMin * 60000;
  const buckets = new Map();

  for (const p of points) {
    const k = Math.floor(p.t / span) * span;
    let b = buckets.get(k);
    if (!b) { b = { sumT: 0, nT: 0, sum: 0, n: 0, max: null, sx: 0, sy: 0, nd: 0 }; buckets.set(k, b); }
    b.sumT += p.t; b.nT++;
    if (p.avg !== null) { b.sum += p.avg; b.n++; }
    if (p.max !== null) b.max = b.max === null ? p.max : Math.max(b.max, p.max);
    if (p.dir !== null) { const r = p.dir * Math.PI / 180; b.sx += Math.sin(r); b.sy += Math.cos(r); b.nd++; }
  }

  return [...buckets.values()]
    .map((b) => ({
      t:   b.sumT / b.nT,
      avg: b.n ? Math.round((b.sum / b.n) * 10) / 10 : null,
      max: b.max,
      dir: b.nd ? (((Math.atan2(b.sx, b.sy) * 180) / Math.PI) + 360) % 360 : null,
    }))
    .sort((a, b) => a.t - b.t);
}

/* ---------------------------------------------------------------------------
   5. Graphe SVG (rendu maison, sans CDN — fonctionne hors-ligne)
   ------------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';

function pickXTicks(t0, t1, maxTicks) {
  const steps = [0.5 * HOUR, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY];
  const span = Math.max(1, t1 - t0);
  let step = steps[steps.length - 1];
  for (const s of steps) { if (span / s <= maxTicks) { step = s; break; } }

  const anchor = new Date(t0);
  anchor.setHours(0, 0, 0, 0);
  const ticks = [];
  for (let t = anchor.getTime(); t <= t1; t += step) if (t >= t0) ticks.push(t);
  return { ticks, step };
}

function buildLine(pts, key, x, y, gapMs) {
  let d = '', pen = false, prevT = null;
  for (const p of pts) {
    const v = p[key];
    if (v === null || v === undefined) { pen = false; prevT = p.t; continue; }
    if (pen && prevT !== null && p.t - prevT > gapMs) pen = false;
    d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true; prevT = p.t;
  }
  return d.trim();
}

/** Bande entre moyenne et rafale : lecture immédiate de la « nervosité » du vent. */
function buildBand(pts, x, y, gapMs) {
  const segs = [];
  let cur = [], prevT = null;
  const flush = () => { if (cur.length > 1) segs.push(cur); cur = []; };

  for (const p of pts) {
    if (p.avg === null || p.max === null) { flush(); prevT = p.t; continue; }
    if (cur.length && prevT !== null && p.t - prevT > gapMs) flush();
    cur.push(p); prevT = p.t;
  }
  flush();

  return segs.map((seg) => {
    const top = seg.map((p) => `${x(p.t).toFixed(1)} ${y(p.max).toFixed(1)}`).join(' L ');
    const bot = seg.slice().reverse().map((p) => `${x(p.t).toFixed(1)} ${y(p.avg).toFixed(1)}`).join(' L ');
    return `M ${top} L ${bot} Z`;
  }).join(' ');
}

/**
 * Dessine la courbe. `pts` sont déjà corrigés et agrégés.
 * Retourne un objet exposant destroy() pour retirer les écouteurs.
 */
function drawChart(wrap, pts, { from, to, gapMs }) {
  const old = wrap.querySelector('svg');
  if (old) old.remove();

  const W = Math.max(280, Math.round(wrap.clientWidth || 340));
  const H = W < 420 ? 240 : 280;
  const compact = W < 360;

  const padL = 34, padR = compact ? 14 : 46, padT = 14, padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const yBase = padT + plotH;

  const t0 = from, t1 = Math.max(to, from + 60000);
  const values = pts.flatMap((p) => [p.avg, p.max]).filter((v) => v !== null);
  const vMax = values.length ? Math.max(...values) : 10;
  const yTop = Math.max(15, Math.ceil((vMax + 2) / 5) * 5);
  const yStep = yTop > 50 ? 10 : 5;

  const x = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
  const y = (v) => yBase - (v / yTop) * plotH;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('role', 'img');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('aria-label',
    `Courbe du vent du ${fmtDayFull(from)} au ${fmtDayFull(to)}. ` +
    `Rafale maximale ${fmtKt(Math.max(...pts.map((p) => p.max ?? 0)))} nœuds. ` +
    `Détail chiffré disponible dans le tableau de données sous le graphe.`);

  const parts = [];

  // Grille horizontale (traits pleins, une nuance au-dessus de la surface)
  for (let v = 0; v <= yTop; v += yStep) {
    const yy = y(v).toFixed(1);
    parts.push(`<line class="${v === 0 ? 'axis-line' : 'grid-line'}" x1="${padL}" y1="${yy}" x2="${padL + plotW}" y2="${yy}"/>`);
    parts.push(`<text class="axis-text" x="${padL - 7}" y="${yy}" text-anchor="end" dominant-baseline="middle">${v}</text>`);
  }

  // Graduations temporelles
  const { ticks, step } = pickXTicks(t0, t1, compact ? 4 : 6);
  const withDay = step >= 6 * HOUR || t1 - t0 > 36 * HOUR;
  for (const t of ticks) {
    const xx = x(t).toFixed(1);
    parts.push(`<line class="grid-line" x1="${xx}" y1="${padT}" x2="${xx}" y2="${yBase}" opacity="0.55"/>`);
    const d = new Date(t);
    const label = withDay
      ? `${d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '')} ${d.getHours()}h`
      : (d.getMinutes() ? fmtHm(t) : `${d.getHours()}h`);
    parts.push(`<text class="axis-text" x="${xx}" y="${yBase + 15}" text-anchor="middle">${escapeHtml(label)}</text>`);
  }

  // Séries : bande moyenne↔rafale, puis les deux lignes pleines de 2 px
  const band = buildBand(pts, x, y, gapMs);
  if (band) parts.push(`<path class="series-band" d="${band}"/>`);
  const dMax = buildLine(pts, 'max', x, y, gapMs);
  const dAvg = buildLine(pts, 'avg', x, y, gapMs);
  if (dMax) parts.push(`<path class="series-line series-line--max" d="${dMax}"/>`);
  if (dAvg) parts.push(`<path class="series-line series-line--avg" d="${dAvg}"/>`);

  // Étiquettes directes en bout de courbe : l'identité ne repose jamais sur la seule couleur
  const lastMax = [...pts].reverse().find((p) => p.max !== null);
  const lastAvg = [...pts].reverse().find((p) => p.avg !== null);
  if (!compact && lastAvg && lastMax) {
    const yA = y(lastAvg.avg), yM = y(lastMax.max);
    const sep = Math.abs(yA - yM) < 13 ? 7 : 0;   // évite le chevauchement des deux libellés
    parts.push(`<text class="end-label" x="${(x(lastMax.t) + 7).toFixed(1)}" y="${(yM - sep).toFixed(1)}" dominant-baseline="middle">raf.</text>`);
    parts.push(`<text class="end-label" x="${(x(lastAvg.t) + 7).toFixed(1)}" y="${(yA + sep).toFixed(1)}" dominant-baseline="middle">moy.</text>`);
  }

  // Bandeau de direction sous l'axe : flèches orientées dans le sens du vent
  const dirPts = pts.filter((p) => p.dir !== null);
  if (dirPts.length) {
    const yStrip = yBase + 32;
    const count = Math.min(compact ? 6 : 9, dirPts.length);
    parts.push(`<text class="dir-strip-label" x="${padL - 7}" y="${yStrip}" text-anchor="end" dominant-baseline="middle">dir.</text>`);
    for (let i = 0; i < count; i++) {
      const p = dirPts[Math.round((i * (dirPts.length - 1)) / Math.max(1, count - 1))];
      // wind_dir_true = provenance ; la flèche montre où va le vent (+180°).
      parts.push(`<path class="dir-tick" d="M0 -5 L3.2 3.4 L0 1.4 L-3.2 3.4 Z" transform="translate(${x(p.t).toFixed(1)} ${yStrip}) rotate(${(p.dir + 180).toFixed(0)})"/>`);
    }
  }

  // Curseur (masqué tant qu'il n'y a pas de survol)
  parts.push(`<g id="cursor" visibility="hidden">
    <line class="crosshair" x1="0" y1="${padT}" x2="0" y2="${yBase}"/>
    <circle class="cursor-dot" r="4.5" fill="var(--series-max)" cx="0" cy="0"/>
    <circle class="cursor-dot" r="4.5" fill="var(--series-avg)" cx="0" cy="0"/>
  </g>`);

  svg.innerHTML = parts.join('');
  wrap.insertBefore(svg, wrap.firstChild);

  /* --- Survol : réticule + infobulle ------------------------------------- */

  const cursor  = svg.querySelector('#cursor');
  const cLine   = cursor.querySelector('line');
  const [cMax, cAvg] = cursor.querySelectorAll('circle');
  const tip     = $('#tooltip');
  let index = -1;

  const nearest = (tx) => {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t < tx) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(pts[lo - 1].t - tx) <= Math.abs(pts[lo].t - tx)) return lo - 1;
    return lo;
  };

  function show(i) {
    if (i < 0 || i >= pts.length) return;
    index = i;
    const p = pts[i];
    const px = x(p.t);

    cursor.setAttribute('visibility', 'visible');
    cLine.setAttribute('x1', px); cLine.setAttribute('x2', px);
    for (const [circle, v] of [[cMax, p.max], [cAvg, p.avg]]) {
      if (v === null) { circle.setAttribute('visibility', 'hidden'); continue; }
      circle.setAttribute('visibility', 'visible');
      circle.setAttribute('cx', px); circle.setAttribute('cy', y(v));
    }

    tip.innerHTML =
      `<div class="tooltip__time">${escapeHtml(fmtDayHm(p.t))}</div>` +
      `<div class="tooltip__row"><span class="tooltip__swatch" style="background:var(--series-avg)"></span>Moyenne<b>${fmtKt(p.avg)} kt</b></div>` +
      `<div class="tooltip__row"><span class="tooltip__swatch" style="background:var(--series-max)"></span>Rafale<b>${fmtKt(p.max)} kt</b></div>` +
      (p.dir !== null ? `<div class="tooltip__row"><span class="tooltip__swatch" style="background:transparent"></span>Direction<b>${Math.round(p.dir)}° ${cardinal(p.dir)}</b></div>` : '');
    tip.hidden = false;

    const scale = (wrap.clientWidth || W) / W;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const half = tw / 2 + 4;
    tip.style.left = `${Math.min(Math.max(px * scale, half), (wrap.clientWidth || W) - half)}px`;
    const highPoint = y(Math.max(p.max ?? 0, p.avg ?? 0)) < padT + plotH / 2;
    tip.style.top = `${(highPoint ? yBase - th - 6 : padT + 4) * scale}px`;
  }

  function hide() {
    index = -1;
    cursor.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  }

  const onMove = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    show(nearest(t0 + ((px - padL) / plotW) * (t1 - t0)));
  };
  const onKey = (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const start = index < 0 ? pts.length - 1 : index + (ev.key === 'ArrowRight' ? 1 : -1);
    show(Math.min(pts.length - 1, Math.max(0, start)));
  };

  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerdown', onMove);
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', onKey);

  return { destroy() { hide(); svg.remove(); } };
}

/* ---------------------------------------------------------------------------
   6. État & rendu de l'interface
   ------------------------------------------------------------------------ */

const state = {
  spotKey: DEFAULT_SPOT,
  range: '24',            // '24' | '48' | 'custom'
  history: [],            // points bruts corrigés, triés
  historyStale: false,
  live: null,
  liveAt: 0,
  liveError: null,
  chart: null,
  loadingHistory: false,
  historyError: null,
};

const spot = () => SPOTS[state.spotKey];

/* --- Carte « vent actuel » ------------------------------------------------- */

function conditionFor(avg) {
  if (avg === null) return null;
  if (avg < 8)  return { label: 'Trop léger',  status: 'none' };
  if (avg < 14) return { label: 'Léger',       status: 'warning' };
  if (avg < 25) return { label: 'Navigable',   status: 'good' };
  if (avg < 33) return { label: 'Costaud',     status: 'serious' };
  return          { label: 'Très fort',        status: 'critical' };
}

function renderLive() {
  const body = $('#live-body');

  if (!state.live) {
    body.innerHTML = state.liveError
      ? `<p class="state-msg state-msg--error"><b>Donnée indisponible.</b>
           <span class="state-msg__hint">${escapeHtml(state.liveError)}</span></p>`
      : `<p class="live__loading skeleton-row">Chargement du relevé…</p>`;
    return;
  }

  const p = state.live;
  const age = Date.now() - p.t;

  // Silence prolongé de la source : on ne fait pas passer un vieux relevé pour actuel.
  if (age > CONFIG.freshStaleMs) {
    body.innerHTML = `<p class="state-msg state-msg--error"><b>Donnée indisponible.</b>
      <span class="state-msg__hint">Dernier relevé reçu ${escapeHtml(relTime(age))} (${escapeHtml(fmtDayHm(p.t))}) — la station ne transmet plus.</span></p>`;
    return;
  }

  const frag = $('#tpl-live').content.cloneNode(true);
  const set = (name, value) => { const el = frag.querySelector(`[data-f="${name}"]`); if (el) el.textContent = value; };

  set('avg', fmtKt(p.avg));
  set('max', fmtKt(p.max));
  set('dir', p.dir === null ? '–' : `${Math.round(p.dir)}°`);
  set('dirFrom', p.dir === null ? '' : `vient du ${cardinal(p.dir)}`);

  const arrow = frag.querySelector('[data-f="dirArrow"]');
  if (p.dir === null) arrow.remove();
  else arrow.style.transform = `rotate(${Math.round(p.dir) + 180}deg)`;   // provenance -> sens de déplacement

  const cond = conditionFor(p.avg);
  const condPill = frag.querySelector('[data-f="condPill"]');
  if (cond) { condPill.dataset.status = cond.status; set('cond', cond.label); }
  else condPill.remove();

  const fresh = age > CONFIG.freshWarnMs ? 'warning' : 'good';
  frag.querySelector('[data-f="freshPill"]').dataset.status = fresh;
  set('fresh', relTime(age));
  set('time', `relevé de ${fmtHm(p.t)}`);

  body.replaceChildren(frag);
}

/* --- Fenêtre temporelle sélectionnée --------------------------------------- */

function autoStep(spanMs) {
  if (spanMs <= 26 * HOUR) return 0;
  if (spanMs <= 50 * HOUR) return 30;
  if (spanMs <= 5 * DAY)   return 60;
  return 180;
}

function historyBounds() {
  const earliest = state.history.length ? state.history[0].t : Date.now() - CONFIG.historyDepthDays * DAY;
  return { earliest, latest: Date.now() };
}

/**
 * Fenêtre courante + message de contrainte éventuel.
 * La sélection personnalisée est bornée à ce que la source fournit réellement.
 */
function currentWindow() {
  const now = Date.now();

  if (state.range !== 'custom') {
    const hours = Number(state.range);
    const from = now - hours * HOUR;
    return { from, to: now, stepMin: autoStep(hours * HOUR), note: '' };
  }

  const { earliest } = historyBounds();
  let from = fromLocalInput($('#in-start').value);
  let to   = fromLocalInput($('#in-end').value);
  const notes = [];

  if (from === null || to === null) {
    from = now - 24 * HOUR; to = now;
  }
  if (from >= to) {
    notes.push('La date de début doit précéder la date de fin.');
    from = to - 6 * HOUR;
  }
  if (from < earliest) {
    notes.push(`L'historique disponible ne remonte qu'au ${fmtDayFull(earliest)}.`);
    from = earliest;
  }
  if (to > now) { to = now; }

  const sel = $('#in-step').value;
  const stepMin = sel === 'auto' ? autoStep(to - from) : Number(sel);

  return { from, to, stepMin, note: notes.join(' ') };
}

/** Historique filtré sur la fenêtre, relevé live inclus s'il est plus récent. */
function pointsForWindow(from, to) {
  const pts = state.history.filter((p) => p.t >= from && p.t <= to);
  const live = state.live;
  if (live && live.t >= from && live.t <= to && (!pts.length || live.t > pts[pts.length - 1].t + 60000)) {
    pts.push(live);
  }
  return pts;
}

/* --- Graphe, résumé, tableau ----------------------------------------------- */

function renderChart() {
  const wrap = $('#chart-wrap');
  const stateEl = $('#chart-state');
  const legend = $('#legend');
  const summary = $('#chart-summary');
  const table = $('#table-view');

  if (state.chart) { state.chart.destroy(); state.chart = null; }

  const showEmpty = (msg) => {
    stateEl.textContent = msg;
    stateEl.hidden = false;
    legend.hidden = true;
    table.hidden = true;
    summary.textContent = '';
    $('#chart-range-label').textContent = '';
  };

  if (state.loadingHistory && !state.history.length) return showEmpty('Chargement de l\'historique… (premier chargement : quelques Mo)');
  if (!state.history.length) return showEmpty(state.historyError || 'Historique indisponible.');

  const { from, to, stepMin, note } = currentWindow();
  const noteEl = $('#custom-note');
  if (state.range === 'custom') {
    const { earliest } = historyBounds();
    noteEl.textContent = note || `Historique disponible depuis le ${fmtDayFull(earliest)} (≈ ${Math.round((Date.now() - earliest) / DAY)} jours).`;
    noteEl.dataset.tone = note ? 'warn' : 'info';
  }

  const raw = pointsForWindow(from, to);
  if (!raw.length) return showEmpty('Aucun relevé sur cette période.');

  const pts = aggregate(raw, stepMin);
  const gapMs = Math.max(stepMin || CONFIG.nativeStepMin, CONFIG.nativeStepMin) * 60000 * 2.6;

  stateEl.hidden = true;
  legend.hidden = false;
  table.hidden = false;

  // Libellés de légende : la valeur courante de chaque série, en encre de texte.
  const lastAvg = [...pts].reverse().find((p) => p.avg !== null);
  const lastMax = [...pts].reverse().find((p) => p.max !== null);
  $('#legend-avg').textContent = lastAvg ? `${fmtKt(lastAvg.avg)} kt` : '–';
  $('#legend-max').textContent = lastMax ? `${fmtKt(lastMax.max)} kt` : '–';

  const stepLabel = stepMin ? (stepMin >= 60 ? `pas ${stepMin / 60} h` : `pas ${stepMin} min`) : 'brut ~10 min';
  $('#chart-range-label').textContent = stepLabel;

  state.chart = drawChart(wrap, pts, { from, to, gapMs });

  const avgs = raw.map((p) => p.avg).filter((v) => v !== null);
  const maxs = raw.map((p) => p.max).filter((v) => v !== null);
  const mean = avgs.length ? Math.round((avgs.reduce((a, b) => a + b, 0) / avgs.length) * 10) / 10 : null;
  summary.textContent =
    `${fmtDayFull(from)} → ${fmtDayFull(to)} · ${raw.length} relevés · ` +
    `moyenne ${fmtKt(mean)} kt · rafale la plus forte ${fmtKt(maxs.length ? Math.max(...maxs) : null)} kt` +
    (state.historyStale ? ' · données en cache (hors ligne)' : '');

  renderTable(pts);
}

function renderTable(pts) {
  const rows = pts.slice().reverse().map((p) => `<tr>
      <td>${escapeHtml(fmtDayHm(p.t))}</td>
      <td>${fmtKt(p.avg)}</td>
      <td>${fmtKt(p.max)}</td>
      <td>${p.dir === null ? '–' : `${Math.round(p.dir)}° ${cardinal(p.dir)}`}</td>
    </tr>`).join('');

  $('#data-table').innerHTML =
    `<thead><tr><th scope="col">Heure</th><th scope="col">Moy. kt</th><th scope="col">Raf. kt</th><th scope="col">Dir.</th></tr></thead>` +
    `<tbody>${rows}</tbody>`;
}

function render() {
  renderLive();
  renderChart();
}

/* ---------------------------------------------------------------------------
   7. Actions & câblage
   ------------------------------------------------------------------------ */

let refreshing = false;

async function refreshLive({ silent = false } = {}) {
  try {
    state.live = await loadLive(spot().windmorbihanNid);
    state.liveAt = Date.now();
    state.liveError = null;
  } catch (err) {
    const cached = readCache('live', spot().windmorbihanNid);
    if (cached && cached.point && !state.live) state.live = cached.point;
    state.liveError = navigator.onLine === false
      ? 'Pas de connexion réseau.'
      : `Impossible de joindre la source (${err.message}).`;
    if (!silent) console.warn('[live]', err);
  }
}

async function refreshHistory({ force = false } = {}) {
  state.loadingHistory = true;
  renderChart();
  try {
    const res = await loadHistory(spot().windmorbihanNid, { force });
    state.history = res.points;
    state.historyStale = Boolean(res.stale);
    state.historyError = null;
  } catch (err) {
    state.historyError = navigator.onLine === false
      ? 'Historique indisponible hors ligne.'
      : `Historique indisponible (${err.message}).`;
    console.warn('[history]', err);
  } finally {
    state.loadingHistory = false;
  }
}

async function refreshAll({ force = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  const btn = $('#refresh-btn');
  btn.classList.add('is-busy');
  try {
    await Promise.all([refreshLive(), refreshHistory({ force })]);
    render();
  } finally {
    btn.classList.remove('is-busy');
    refreshing = false;
  }
}

function syncCustomInputs() {
  const { earliest, latest } = historyBounds();
  const start = $('#in-start'), end = $('#in-end');
  start.min = end.min = toLocalInput(earliest);
  start.max = end.max = toLocalInput(latest);
  if (!start.value) start.value = toLocalInput(Math.max(earliest, latest - 24 * HOUR));
  if (!end.value)   end.value   = toLocalInput(latest);
}

function setRange(range) {
  state.range = range;
  for (const btn of document.querySelectorAll('.range-btn')) {
    btn.classList.toggle('is-active', btn.dataset.range === range);
    btn.setAttribute('aria-pressed', String(btn.dataset.range === range));
  }
  const custom = range === 'custom';
  $('#custom-panel').hidden = !custom;
  if (custom) syncCustomInputs();
  renderChart();
}

function initSpotSelector() {
  const keys = Object.keys(SPOTS);
  if (keys.length < 2) return;                 // un seul spot : pas de sélecteur
  const wrap = $('#spot-select-wrap'), sel = $('#spot-select');
  sel.innerHTML = keys.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(SPOTS[k].label)}</option>`).join('');
  sel.value = state.spotKey;
  wrap.hidden = false;
  sel.addEventListener('change', () => {
    state.spotKey = sel.value;
    state.history = []; state.live = null;
    refreshAll({ force: true });
  });
}

function init() {
  $('#app-version').textContent = APP_VERSION;
  initSpotSelector();

  for (const btn of document.querySelectorAll('.range-btn')) {
    btn.addEventListener('click', () => setRange(btn.dataset.range));
  }
  for (const id of ['#in-start', '#in-end', '#in-step']) {
    $(id).addEventListener('change', renderChart);
  }
  $('#refresh-btn').addEventListener('click', () => refreshAll({ force: true }));

  // Affichage immédiat du dernier relevé connu, avant même le réseau.
  const cachedLive = readCache('live', spot().windmorbihanNid);
  if (cachedLive && cachedLive.point) { state.live = cachedLive.point; renderLive(); }

  refreshAll();

  setInterval(() => { if (!document.hidden) refreshAll(); }, CONFIG.liveRefreshMs);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - state.liveAt > CONFIG.liveRefreshMs) refreshAll();
  });
  window.addEventListener('online', () => refreshAll({ force: true }));

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderChart, 150);
  });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js', { scope: './' }).catch((e) => console.warn('[sw]', e));
    });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
