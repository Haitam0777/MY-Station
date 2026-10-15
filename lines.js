// ---------------------------------------------------------------------------
// Outils partagés : tracés des lignes IDFM, gares dans l'ordre, couleurs
// (utilisé par le schéma de ligne de l'écran Station et par le plan du réseau)
// ---------------------------------------------------------------------------
const OPENDATA_URL = "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets";
const SHAPES_URL = `${OPENDATA_URL}/traces-des-lignes-de-transport-en-commun-idfm/exports/geojson`;
const SNAP_METERS = 300; // arrêt plus loin que ça du tracé : ignoré

// Appel à l'API PRIM (Île-de-France Mobilités)
// - site publié : via le proxy du site (/api/prim/…), la clé reste secrète côté serveur
// - test en local (Live Server) : en direct avec la clé de config.local.js
function primFetch(path, params = "", headers = {}) {
  const query = String(params) ? `?${params}` : "";
  if (CONFIG.primApiKey) {
    return fetch(`https://prim.iledefrance-mobilites.fr/marketplace/${path}${query}`, {
      headers: { ...headers, apikey: CONFIG.primApiKey },
    });
  }
  return fetch(`${CONFIG.primProxy || "/api/prim"}/${path}${query}`, { headers });
}

// "STIF:Line::C01727:" ou "IDFM:C01727" -> "C01727"
const lineCode = (ref) => (ref || "").split(":").filter(Boolean).pop() || "";

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Texte noir ou blanc selon la couleur de fond
function textOn(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#111827" : "#ffffff";
}

// Projection plane locale en mètres (suffisant à l'échelle de l'Île-de-France)
const toXY = (lat, lon) => ({ x: lon * 111320 * Math.cos((48.85 * Math.PI) / 180), y: lat * 110540 });

const ROUTE_MODES = { Subway: "Metro", Rail: "RapidTransit", Tram: "Tramway", Bus: "Bus", Funicular: "Funicular" };

// Entité GeoJSON du jeu de données « traces » -> ligne avec ses morceaux de tracé
function buildLine(feature) {
  const p = feature.properties;
  const g = feature.geometry;
  if (!g) return null;
  const rawParts = g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
  const parts = rawParts.map((coords) => {
    const pts = coords.map(([lon, lat]) => ({ lat, lon, ...toXY(lat, lon) }));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    return { pts, cum };
  });
  return {
    id: lineCode(p.route_id),
    name: p.route_short_name,
    mode: ROUTE_MODES[p.route_type] || p.route_type,
    color: `#${p.route_color || "1f5fbf"}`,
    parts,
  };
}

// Point du tracé le plus proche : morceau + distance depuis son début
function projectPoint(line, lat, lon, onlyPart = null) {
  const p = toXY(lat, lon);
  let best = null;
  line.parts.forEach((part, partIndex) => {
    if (onlyPart !== null && partIndex !== onlyPart) return;
    for (let i = 1; i < part.pts.length; i++) {
      const a = part.pts[i - 1];
      const b = part.pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      const d = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
      if (!best || d < best.d) best = { part: partIndex, s: part.cum[i - 1] + t * Math.sqrt(len2), d };
    }
  });
  return best && best.d <= SNAP_METERS ? best : null;
}

// Coordonnées à la distance s sur un morceau de tracé
function pointAt(part, s) {
  const { pts, cum } = part;
  s = Math.max(0, Math.min(cum[cum.length - 1], s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const span = cum[i] - cum[i - 1] || 1;
  const t = (s - cum[i - 1]) / span;
  return [pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t, pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * t];
}

// Gares d'une ligne (jeu de données « arrets-lignes »)
async function lineStopsOf(lineId) {
  const rows = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const params = new URLSearchParams({
      select: "stop_name,pointgeo",
      where: `id="IDFM:${lineId}"`,
      limit: "100",
      offset: String(offset),
    });
    const { results = [] } = await (await fetch(`${OPENDATA_URL}/arrets-lignes/records?${params}`)).json();
    rows.push(...results);
    if (results.length < 100) break;
  }
  return rows.filter((r) => r.pointgeo);
}

// Pour chaque morceau de tracé : sa longueur et ses gares, dans l'ordre du tracé
function orderStops(line, stops, minLength = 0) {
  return line.parts
    .map((part, index) => {
      const onPart = [];
      for (const st of stops) {
        const proj = projectPoint(line, st.pointgeo.lat, st.pointgeo.lon, index);
        if (proj && !onPart.some((o) => o.name === st.stop_name && Math.abs(o.s - proj.s) < 400)) {
          onPart.push({ s: proj.s, name: st.stop_name, lat: st.pointgeo.lat, lon: st.pointgeo.lon });
        }
      }
      return { index, len: part.cum[part.cum.length - 1], stops: onPart.sort((a, b) => a.s - b.s) };
    })
    .filter((p) => p.len >= minLength);
}

// Tracé + gares ordonnées d'une ligne, chargés une seule fois
const lineGeoCache = new Map();
function lineGeometry(lineId) {
  if (!lineGeoCache.has(lineId)) {
    const promise = (async () => {
      const params = new URLSearchParams({
        select: "route_id,route_short_name,route_type,route_color,shape",
        where: `route_id="IDFM:${lineId}"`,
      });
      const geo = await (await fetch(`${SHAPES_URL}?${params}`)).json();
      const line = geo.features?.[0] && buildLine(geo.features[0]);
      if (!line) return null;
      const stops = await lineStopsOf(lineId);
      return { ...line, ordered: orderStops(line, stops) };
    })().catch(() => {
      lineGeoCache.delete(lineId); // on réessaiera plus tard
      return null;
    });
    lineGeoCache.set(lineId, promise);
  }
  return lineGeoCache.get(lineId);
}

// Couleurs officielles (jeu de données « referentiel-des-lignes »)
const lineColors = new Map(); // id -> { bg, fg }
async function loadLineColors(ids) {
  const missing = ids.filter((id) => id && !lineColors.has(id));
  if (!missing.length) return;
  const params = new URLSearchParams({
    select: "id_line,colourweb_hexa,textcolourweb_hexa",
    where: `id_line in (${missing.map((id) => `"${id}"`).join(",")})`,
    limit: "100",
  });
  try {
    const { results = [] } = await (await fetch(`${OPENDATA_URL}/referentiel-des-lignes/records?${params}`)).json();
    results.forEach((r) =>
      lineColors.set(r.id_line, {
        bg: `#${r.colourweb_hexa || "1f5fbf"}`,
        fg: r.textcolourweb_hexa ? `#${r.textcolourweb_hexa}` : textOn(r.colourweb_hexa || "1f5fbf"),
      })
    );
  } catch {
    // Couleurs par défaut
  }
}
const colorOf = (id) => lineColors.get(id) || { bg: "#1f5fbf", fg: "#ffffff" };
