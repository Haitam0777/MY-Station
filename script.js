// ---------------------------------------------------------------------------
// Ma Station : tableau de bord temps réel (API PRIM d'Île-de-France Mobilités)
// ---------------------------------------------------------------------------
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const ROUTE_URL = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const TICK_MS = 250; // plusieurs fois par seconde : aucune seconde sautée
const REROUTE_METERS = 50;
const MERGE_METERS = 600; // zones de même nom plus proches que ça = même station

// Modes du jeu de données « arrets-lignes »
const MODES = {
  Metro: "Métro",
  RapidTransit: "RER",
  LocalTrain: "Train",
  Train: "Train",
  Tramway: "Tram",
  Funicular: "Funiculaire",
  CableWay: "Câble",
  Bus: "Bus",
};
const MODE_ORDER = Object.keys(MODES);
// Pictogramme de mode (« M », « RER »…)
const MODE_SHORT = { Metro: "M", RapidTransit: "RER", LocalTrain: "TN", Train: "TN", Tramway: "T", Bus: "BUS", Funicular: "F", CableWay: "C" };
const NOUNS = { Metro: "métro", Bus: "bus", Tramway: "tram" };
// Temps moyen entre deux gares (minutes), pour placer le train sur le schéma
const MINUTES_PER_STOP = { Metro: 1.6, RapidTransit: 3, LocalTrain: 4, Train: 4, Tramway: 2, Bus: 1.5 };
// Types du jeu de données « arrets »
const STOP_TYPES = { metro: "Métro", rail: "RER / Train", tram: "Tram", funicular: "Funiculaire", bus: "Bus" };
const STOP_TYPE_ORDER = Object.keys(STOP_TYPES);

const $ = (id) => document.getElementById(id);
const picker = $("picker");
const pickerList = $("picker-list");
const pickerSearch = $("picker-search");

// Réglages (page « Réglages ») : point de départ et marge, mémorisés dans le navigateur
let settings = loadSettings();
const marginMinutes = () => settings.margin || 0;

let station = loadStation();
let trains = [];
let walkMinutes = CONFIG.walkMinutes;
let walkLabel = walkText("estimation");
let lastOrigin = null; // dernier point de départ connu { lat, lon }
let lastRouted = null;
let gpsWatch = null;

// Mode simulation : index.html?sim=2026-10-15T18:00 (heure de Paris)
// L'horloge part de cette date, les passages sont générés et la météo vient des prévisions.
// La simulation dure 15 minutes puis l'horloge repart de l'heure de départ (en boucle).
const SIM_START = (new URLSearchParams(location.search).get("sim") || "").replace(/[^\dT:-]/g, "");
const SIM_START_MS = SIM_START && !isNaN(new Date(SIM_START)) ? new Date(SIM_START).getTime() : 0;
const SIM_REAL_START = Date.now();
const SIM_DURATION_MS = 15 * 60000;
const simOffset = SIM_START_MS ? SIM_START_MS - SIM_REAL_START : 0; // ≠ 0 : mode simulation
const simElapsed = () => (Date.now() - SIM_REAL_START) % SIM_DURATION_MS;
const simLap = () => Math.floor((Date.now() - SIM_REAL_START) / SIM_DURATION_MS);
const now = () => (simOffset ? SIM_START_MS + simElapsed() : Date.now());

const formatTime = (date) =>
  date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

// ---------------------------------------------------------------------------
// Station choisie (mémorisée dans le navigateur, sinon celle de config.js)
// ---------------------------------------------------------------------------
// Une station peut regrouper plusieurs zones d'arrêt (ex. Saint-Ouen : métro, RER, bus)
const zonesOf = (s) => s.zdaids || [s.zdaid];
const stationKey = (s) => zonesOf(s).join(",");

function loadSettings() {
  const defaults = {
    origin: CONFIG.useGps ? "gps" : "address",
    address: null,
    margin: CONFIG.marginMinutes || 0,
    nearbyMeters: 500, // rayon des stations proches, à vol d'oiseau
    sound: true, // bips dans les 50 dernières secondes
    volume: 70, // volume des alertes, en %
    favorites: [], // trajets enregistrés : { id, name, station, from, to }
    autoRoutine: true, // bascule automatique sur le trajet de la tranche horaire
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem("settings")) };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem("settings", JSON.stringify(settings));
  } catch {
    // Stockage indisponible : réglages valables pour cette session
  }
}

function loadStation() {
  try {
    const saved = JSON.parse(localStorage.getItem("station"));
    if (saved?.zdaids || saved?.zdaid) return saved;
  } catch {
    // Valeur illisible : on repart de la config
  }
  const s = CONFIG.station;
  return { ...s, lines: s.line ? [s.line] : [] };
}

function applyStation(next) {
  const moved = stationKey(next) !== stationKey(station) || next.line?.id !== station.line?.id;
  station = next;
  try {
    localStorage.setItem("station", JSON.stringify(station));
  } catch {
    // Stockage indisponible : le choix vaut pour cette session
  }
  trains = [];
  lastRouted = null;
  drawn = {};
  render();
  loadTrains();
  loadWeather();
  loadLineColors(station.lines.map((l) => l.id)).then(() => ((drawn = {}), render()));
  if (moved && lastOrigin) updateWalk(lastOrigin); // nouveau trajet à pied
  renderSettings();
  renderNearby(); // met en avant la nouvelle station actuelle
  renderTraffic(); // info trafic des nouvelles lignes
}

const findLine = (id) => station.lines.find((l) => l.id === id);

// ---------------------------------------------------------------------------
// Prochains passages
// ---------------------------------------------------------------------------
// Terminus connus de chaque ligne, par sens (simulation et choix de destination)
const SIM_TERMINI = {
  "Metro:1": [["La Défense"], ["Château de Vincennes"]],
  "Metro:2": [["Porte Dauphine"], ["Nation"]],
  "Metro:3": [["Pont de Levallois - Bécon"], ["Gallieni"]],
  "Metro:3B": [["Gambetta"], ["Porte des Lilas"]],
  "Metro:4": [["Porte de Clignancourt"], ["Bagneux - Lucie Aubrac"]],
  "Metro:5": [["Bobigny - Pablo Picasso"], ["Place d'Italie"]],
  "Metro:6": [["Charles de Gaulle - Étoile"], ["Nation"]],
  "Metro:7": [["La Courneuve - 8 Mai 1945"], ["Mairie d'Ivry", "Villejuif - Louis Aragon"]],
  "Metro:7B": [["Louis Blanc"], ["Pré-Saint-Gervais"]],
  "Metro:8": [["Balard"], ["Pointe du Lac"]],
  "Metro:9": [["Pont de Sèvres"], ["Mairie de Montreuil"]],
  "Metro:10": [["Boulogne - Pont de Saint-Cloud"], ["Gare d'Austerlitz"]],
  "Metro:11": [["Châtelet"], ["Rosny-Bois-Perrier"]],
  "Metro:12": [["Mairie d'Issy"], ["Mairie d'Aubervilliers"]],
  "Metro:13": [["Saint-Denis - Université", "Les Courtilles"], ["Châtillon - Montrouge"]],
  "Metro:14": [["Saint-Denis Pleyel"], ["Aéroport d'Orly"]],
  "RapidTransit:A": [["Saint-Germain-en-Laye", "Cergy-le-Haut", "Poissy"], ["Boissy-Saint-Léger", "Marne-la-Vallée Chessy"]],
  "RapidTransit:B": [["Aéroport CDG 2", "Mitry - Claye"], ["Robinson", "Saint-Rémy-lès-Chevreuse"]],
  "RapidTransit:C": [["Pontoise", "Montigny - Beauchamp"], ["Versailles Château Rive Gauche", "Saint-Quentin-en-Yvelines", "Massy - Palaiseau"]],
  "RapidTransit:D": [["Creil", "Orry-la-Ville - Coye"], ["Melun", "Corbeil-Essonnes", "Malesherbes"]],
  "RapidTransit:E": [["Haussmann - Saint-Lazare"], ["Chelles - Gournay", "Tournan"]],
};
// Intervalle entre deux passages par sens à l'heure de pointe (minutes)
const SIM_EVERY = { Metro: 3, RapidTransit: 8, LocalTrain: 15, Train: 15, Tramway: 6, Bus: 10 };

// Passages fictifs pour le mode simulation (cadence de pointe)
function simulatedTrains() {
  const lines = station.line ? [station.line] : station.lines.length ? station.lines : [{ id: "", name: "", mode: "" }];
  const hour = new Date(now());
  hour.setMinutes(0, 0, 0);
  const list = [];

  lines.forEach((line, li) => {
    const every = SIM_EVERY[line.mode] || 10;
    // Terminus connus, sinon ceux du tracé réel (chargé à la demande)
    let termini = SIM_TERMINI[`${line.mode}:${line.name}`];
    if (!termini && line.id) {
      ensureGeo(line.id);
      termini = geoTermini(line);
    }
    termini = termini || [["Terminus"], ["Terminus"]];
    // Destination choisie absente des terminus connus (ex. venue d'un itinéraire) :
    // elle devient l'un des deux sens simulés
    const wanted = wantedDestinations();
    if (wanted.length && !termini.flat().some((n) => wanted.some((w) => sameDestination(n, w)))) {
      termini = [wanted, termini[1] || termini[0]];
    }
    termini.forEach((names, dirIndex) => {
      // Pas de train « vers » la station où l'on se trouve (terminus)
      const destinations = names.filter((n) => n.toLowerCase() !== station.name.toLowerCase());
      if (!destinations.length) return;
      // Les deux sens sont décalés d'une demi-cadence pour ne pas tomber à la même minute
      const offset = 1 + li + Math.round((dirIndex * every) / 2);
      for (let i = 0, m = offset; m < 120; i++, m += every) {
        const delay = (i * 7 + li + dirIndex) % 5 === 0 ? 60000 : 0; // quelques retards
        const time = new Date(hour.getTime() + m * 60000 + delay);
        if (time - now() > -60000) {
          list.push({ time, lineId: line.id, destination: destinations[i % destinations.length], platform: `Voie ${dirIndex + 1}` });
        }
      }
    });
  });
  return list.sort((a, b) => a.time - b.time);
}

// Passages d'une zone d'arrêt
async function fetchVisits(zdaid) {
  const ref = `STIF:StopArea:SP:${zdaid}:`;
  const res = await primFetch("stop-monitoring", new URLSearchParams({ MonitoringRef: ref }));
  if (res.status === 401 || res.status === 403) throw new Error("clé API refusée");
  if (!res.ok) throw new Error(`erreur PRIM ${res.status}`);
  const data = await res.json();
  return data.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]?.MonitoredStopVisit || [];
}

// Passages en temps réel des zones d'une station (format interne)
async function fetchTrains(target) {
  const zones = target.line?.zones || zonesOf(target);
  const results = await Promise.allSettled(zones.map(fetchVisits));
  const failed = results.find((r) => r.status === "rejected");
  if (failed && results.every((r) => r.status === "rejected")) throw failed.reason;
  return results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .map(({ MonitoredVehicleJourney: journey = {} }) => {
      const call = journey.MonitoredCall || {};
      const time = call.ExpectedDepartureTime || call.ExpectedArrivalTime || call.AimedDepartureTime || call.AimedArrivalTime;
      const destination =
        call.DestinationDisplay?.[0]?.value || journey.DestinationName?.[0]?.value || journey.DirectionName?.[0]?.value || "";
      const platform = call.ArrivalPlatformName?.value || call.DeparturePlatformName?.value;
      return {
        time: time && new Date(time),
        destination,
        lineId: lineCode(journey.LineRef?.value),
        platform: platform ? `Voie ${platform}` : "",
      };
    })
    .filter((t) => t.time && (!target.line || t.lineId === target.line.id));
}

// Destinations choisies pour la station (sinon celles de config.js) ; vide = toutes
const wantedDestinations = () => (station.destinations?.length ? station.destinations : CONFIG.destinations);

// « Montigny - Beauchamp » correspond à « Montigny-Beauchamp »
function sameDestination(a, b) {
  const x = normalizeName(a || "");
  const y = normalizeName(b || "");
  return x && y && (x.includes(y) || y.includes(x));
}

// Chargements en cours : barre animée sous l'en-tête tant qu'il en reste
let pendingLoads = 0;
function busy(delta) {
  pendingLoads = Math.max(0, pendingLoads + delta);
  document.body.classList.toggle("busy", pendingLoads > 0);
}

let statusText = "";
async function loadTrains() {
  const key = stationKey(station);
  let list = null;
  if (simOffset) {
    list = simulatedTrains();
    statusText = "Passages simulés";
  } else {
    busy(1);
    try {
      list = await fetchTrains(station);
      statusText = `Mis à jour à ${formatTime(new Date())}`;
    } catch (err) {
      statusText = `Hors ligne : ${err.message}`;
    } finally {
      busy(-1);
    }
  }
  if (key !== stationKey(station)) return; // la station a changé entre-temps

  if (list) {
    const wanted = wantedDestinations();
    trains = list
      .filter((t) => !wanted.length || wanted.some((w) => sameDestination(t.destination, w)))
      .sort((a, b) => a.time - b.time);
  }
  render();
}

// ---------------------------------------------------------------------------
// Météo actuelle (Open-Meteo, sans clé)
// ---------------------------------------------------------------------------
async function loadWeather() {
  try {
    const params = new URLSearchParams({
      latitude: station.lat,
      longitude: station.lon,
      current: "temperature_2m,weather_code,is_day",
      timezone: "Europe/Paris",
    });
    let current;
    if (simOffset) {
      // Prévision horaire pour l'heure simulée
      const d = new Date(now());
      const pad = (n) => String(n).padStart(2, "0");
      const hour = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
      params.delete("current");
      params.set("hourly", "temperature_2m,weather_code,is_day");
      params.set("start_hour", hour);
      params.set("end_hour", hour);
      const { hourly } = await (await fetch(`${WEATHER_URL}?${params}`)).json();
      current = { temperature_2m: hourly.temperature_2m[0], weather_code: hourly.weather_code[0], is_day: hourly.is_day[0] };
    } else {
      ({ current } = await (await fetch(`${WEATHER_URL}?${params}`)).json());
    }
    $("weather-temp").textContent = `${Math.round(current.temperature_2m)}°`;
    $("weather-icon").innerHTML = weatherIcon(current.weather_code, current.is_day);
  } catch {
    // On garde la dernière météo affichée
  }
}

// Icônes météo au trait (codes WMO)
function weatherIcon(code, isDay) {
  const sun =
    '<circle cx="9" cy="9" r="3.5"/><path d="M9 2v1.5M9 14.5V16M2 9h1.5M14.5 9H16M4 4l1 1M13 13l1 1M4 14l1-1M13 5l1-1"/>';
  const moon = '<path d="M12 3.5a5.5 5.5 0 1 0 3.5 9.5A6 6 0 0 1 12 3.5z"/>';
  const cloud = '<path d="M7 20h11a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 20z" fill="var(--bg)"/>';
  const rain = '<path d="M9 22l-1 1.5M13 22l-1 1.5M17 22l-1 1.5"/>';
  const snow = '<path d="M9 22.5h.01M13 22.5h.01M17 22.5h.01"/>';
  const bolt = '<path d="M13 15l-2 4h3l-2 4"/>';
  const fog = '<path d="M3 9h18M3 13h18M5 17h14"/>';
  const sky = isDay ? sun : moon;

  let body;
  if (code === 0) body = sky;
  else if (code <= 3) body = sky + cloud;
  else if (code <= 48) body = fog;
  else if (code <= 67 || (code >= 80 && code <= 82)) body = cloud + rain;
  else if (code <= 77 || code === 85 || code === 86) body = cloud + snow;
  else body = cloud + bolt;

  return `<svg viewBox="0 0 26 26" aria-hidden="true">${body}</svg>`;
}

// ---------------------------------------------------------------------------
// Temps de marche depuis le point de départ (GPS ou adresse des réglages)
// ---------------------------------------------------------------------------
function distanceMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Itinéraire piéton OSRM, sinon estimation à vol d'oiseau
async function updateWalk(here) {
  lastOrigin = here;
  if (lastRouted && distanceMeters(here, lastRouted) < REROUTE_METERS) return;
  lastRouted = here;

  const target = station;
  let seconds;
  let meters;
  try {
    const path = `${here.lon},${here.lat};${target.lon},${target.lat}`;
    const { routes } = await (await fetch(`${ROUTE_URL}/${path}?overview=false`)).json();
    ({ duration: seconds, distance: meters } = routes[0]);
  } catch {
    // Hors ligne : vol d'oiseau × 1,3 (détours) à 4,5 km/h
    meters = distanceMeters(here, target) * 1.3;
    seconds = meters / (4500 / 3600);
  }
  if (target !== station || here !== lastOrigin) return; // station ou départ changé entre-temps

  walkMinutes = Math.ceil(seconds / 60);
  const distance = meters >= 1000 ? `${(meters / 1000).toFixed(1).replace(".", ",")} km` : `${Math.round(meters / 10) * 10} m`;
  walkLabel = walkText(distance);
  render();
  renderSettings();
  loadNearby(); // stations proches de ce point de départ
}

// « à pied 13 min + 4 marge · 1,2 km »
function walkText(detail) {
  const margin = marginMinutes() ? ` + ${marginMinutes()} marge` : "";
  return `à pied ${walkMinutes} min${margin} · ${detail}`;
}

// Point de départ : position GPS suivie en continu, ou adresse fixe
function startOrigin() {
  if (gpsWatch !== null) {
    navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = null;
  }
  lastOrigin = null;
  lastRouted = null;
  walkMinutes = CONFIG.walkMinutes;

  if (settings.origin === "address") {
    if (settings.address) updateWalk({ lat: settings.address.lat, lon: settings.address.lon });
    else walkLabel = walkText("aucune adresse de départ");
  } else if (!window.isSecureContext || !navigator.geolocation) {
    walkLabel = walkText("GPS indisponible");
  } else {
    walkLabel = walkText("recherche GPS…");
    gpsWatch = navigator.geolocation.watchPosition(
      (p) => updateWalk({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => {
        walkLabel = walkText("GPS refusé");
        render();
        renderSettings();
      },
      { enableHighAccuracy: true, maximumAge: 60000, timeout: 30000 }
    );
  }
  render();
  renderSettings();
  renderNearby();
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------
let drawn = {}; // dernières valeurs dessinées, pour ne toucher au DOM que si besoin

// N'écrit dans le DOM que si la valeur a changé
function paint(key, value, apply) {
  if (drawn[key] === value) return;
  drawn[key] = value;
  apply(value);
}

const minutesUntil = (t, nowMs) => Math.max(0, Math.floor((t.time - nowMs) / 60000));
const minutesText = (m) => (m <= 0 ? "à quai" : `${m} min`);
const isRect = (mode) => mode !== "Metro";

// Pastilles « (M) (2) »
function pairHtml(line) {
  if (!line) return "";
  const c = colorOf(line.id);
  const short = MODE_SHORT[line.mode] || "•";
  return (
    `<span class="pair"><span class="mini-mode${short.length > 1 ? " text" : ""}">${escapeHtml(short)}</span>` +
    `<span class="mini-line${isRect(line.mode) ? " rect" : ""}" style="background:${c.bg};color:${c.fg}">${escapeHtml(line.name)}</span></span>`
  );
}

let lastBeep = "";
let lastLap = 0;

function render() {
  // Simulation repartie du début : nouveaux passages pour cette heure
  if (simOffset && simLap() !== lastLap) {
    lastLap = simLap();
    trains = [];
    drawn = {};
    loadTrains();
    loadWeather();
    renderTraffic();
  }
  checkRoutine(); // trajet favori de la tranche horaire
  const nowMs = now();
  const walkMs = (walkMinutes + marginMinutes()) * 60000;
  const upcoming = trains.filter((t) => t.time - nowMs > -30000);
  const reachable = upcoming.filter((t) => t.time - nowMs >= walkMs);
  const mine = reachable[0];
  const focus = mine || upcoming[0];
  const focusLine = station.line || (focus && findLine(focus.lineId)) || station.lines[0];
  const wanted = wantedDestinations();

  // En-tête
  const date = new Date(nowMs);
  $("clock").textContent = formatTime(date);
  paint("date", date.toDateString(), () => {
    const label = date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    $("date").textContent = label.charAt(0).toUpperCase() + label.slice(1);
  });
  paint("subtitle", simOffset ? "sim" : "live", (v) => {
    $("subtitle").textContent = v === "sim" ? "Simulation · horaires fictifs" : "Suivi du métro en temps réel";
  });

  // Ligne + direction
  paint("hero", `${focusLine?.id}|${focusLine?.mode}|${station.lines.length}|${colorOf(focusLine?.id).bg}`, () => {
    const short = MODE_SHORT[focusLine?.mode] || "•";
    const modeBadge = $("mode-badge");
    modeBadge.textContent = short;
    modeBadge.classList.toggle("small-text", short.length > 1);
    const lineBadge = $("line-badge");
    const c = colorOf(focusLine?.id);
    lineBadge.textContent = focusLine?.name || "•";
    lineBadge.classList.toggle("long", (focusLine?.name || "").length > 2);
    lineBadge.style.background = c.bg;
    lineBadge.style.color = c.fg;
    lineBadge.style.borderRadius = focusLine && !isRect(focusLine.mode) ? "50%" : "";
    $("hero-badges").classList.toggle("switchable", station.lines.length > 1);
  });
  // Vocabulaire selon le mode : « Prochain bus », « Votre tram »…
  paint("nouns", focusLine?.mode, (mode) => {
    const noun = NOUNS[mode] || "train";
    $("hero-noun").textContent = `Prochain ${noun}`;
    $("next-title").textContent = `Votre ${noun}`;
    $("departures-title").textContent = station.line ? `Prochains ${noun.endsWith("s") ? noun : `${noun}s`}` : "Prochains départs";
  });
  const direction = focus?.destination || (wanted.length ? wanted.join(" / ") : "Toutes directions");
  paint("direction", direction, (v) => ($("direction").textContent = v));
  // Prochain train dans la direction affichée (même s'il est trop juste pour vous)
  const heroTrain = focus && upcoming.find((t) => t.lineId === focus.lineId && t.destination === focus.destination);
  paint("heroMin", heroTrain ? minutesText(minutesUntil(heroTrain, nowMs)) : "–", (v) => ($("hero-minutes").textContent = v));

  // Prochains trains
  const list = upcoming.slice(0, 5);
  const listKey = list.map((t) => `${t.lineId}|${t.destination}|${t.platform}|${minutesUntil(t, nowMs)}|${t.time - nowMs >= walkMs}`).join(";");
  paint("departures", `${listKey}|${colorOf(focusLine?.id).bg}`, () => {
    $("departures").innerHTML = list.length
      ? list
          .map((t) => {
            const late = t.time - nowMs < walkMs;
            const sub = [t.platform, `à ${formatTime(t.time)}`, late ? "trop juste" : ""].filter(Boolean).join(" · ");
            return (
              `<li class="${late ? "late" : ""}">${pairHtml(findLine(t.lineId) || focusLine)}` +
              `<span><span class="dest">${escapeHtml(t.destination || "—")}</span><small>${escapeHtml(sub)}</small></span>` +
              `<span class="mins">${minutesText(minutesUntil(t, nowMs))}</span></li>`
            );
          })
          .join("")
      : `<li><span class="empty">${escapeHtml(wanted.length ? "Aucun passage vers ces destinations" : "Aucun passage annoncé")}</span></li>`;
  });

  // Votre train (le premier qu'on peut attraper à pied)
  paint("mine", mine ? `${mine.lineId}|${mine.destination}|${minutesUntil(mine, nowMs)}|${colorOf(mine.lineId).bg}` : "none", () => {
    $("next-dest").textContent = mine ? mine.destination || "—" : "Aucun train à attraper";
    $("next-badges").innerHTML = mine ? pairHtml(findLine(mine.lineId) || focusLine) : "";
    $("next-min").textContent = mine ? minutesText(minutesUntil(mine, nowMs)) : "";
  });
  // Barre : le train approche (pleine = à quai), sur 15 minutes
  const progress = mine ? Math.max(0, Math.min(1, 1 - (mine.time - nowMs) / (15 * 60000))) : 0;
  $("progress-fill").style.width = `${progress * 100}%`;
  $("progress-train").style.left = `${progress * 100}%`;
  const leaveAt = mine && new Date(mine.time - walkMs);
  paint("nextInfo", mine ? `${formatTime(mine.time)}|${formatTime(leaveAt)}|${mine.platform}` : "", () => {
    $("next-info").textContent = mine
      ? [`Départ ${formatTime(mine.time)}`, mine.platform, `partez à ${formatTime(leaveAt)}`].filter(Boolean).join(" · ")
      : "";
  });

  // Perturbation en cours qui concerne votre trajet
  paint("trafficAlert", trafficAlert ? `${trafficAlert.d.id}|${trafficAlert.here}` : "", () => {
    const el = $("next-alert");
    el.hidden = !trafficAlert;
    if (!trafficAlert) return;
    el.className = `next-alert sev-${trafficAlert.severity.cls}`;
    el.textContent = `⚠ ${trafficAlert.here ? "Votre station est concernée" : "Ligne perturbée"} : ${trafficAlert.d.title}`;
  });

  // Afficheur de quai : quand partir (paliers de 10 s) + résumé
  paint("platformStation", station.name, (v) => ($("platform-station").textContent = v));
  const mineName = mine && (findLine(mine.lineId) || focusLine);
  paint("facts", `${mine ? `${mine.time.getTime()}|${mine.destination}` : ""}|${walkLabel}|${mineName?.id}`, () => {
    $("fact-leave").textContent = mine ? formatTime(leaveAt) : "–";
    $("fact-depart").innerHTML = mine
      ? `${formatTime(mine.time)}<small>${escapeHtml(
          [mineName ? `${MODES[mineName.mode] || ""} ${mineName.name}`.trim() : "", mine.destination && `→ ${mine.destination}`]
            .filter(Boolean)
            .join(" ")
        )}</small>`
      : "–";
    const [walkPart, detail] = walkLabel.split(" · ");
    $("fact-walk").innerHTML = `${escapeHtml(walkPart.replace(/^à pied /, ""))}<small>${escapeHtml(`à pied${detail ? ` · ${detail}` : ""}`)}</small>`;
  });
  // Compte à rebours à la seconde
  const seconds = mine ? Math.max(0, Math.floor((mine.time - nowMs - walkMs) / 1000)) : null;
  paint("countdown", seconds, () => {
    const el = $("countdown");
    el.classList.toggle("go", seconds === null);
    el.innerHTML =
      seconds === null
        ? '<span class="cd-min">–</span>'
        : `<span class="cd-min">${Math.floor(seconds / 60)}</span><span class="cd-unit">min</span>` +
          `<span class="cd-sec">${String(seconds % 60).padStart(2, "0")}</span><span class="cd-unit">s</span>`;
  });

  // Alertes : orange sous 5 min, rouge clignotant à 2 min et moins
  const urgency = seconds === null ? "" : seconds <= 120 ? "urgent" : seconds <= 300 ? "soon" : "";
  paint("urgency", urgency, (v) => {
    const platform = document.querySelector(".platform");
    platform.classList.toggle("urgent", v === "urgent");
    platform.classList.toggle("soon", v === "soon");
  });
  // 50 dernières secondes : un bip par palier de 10 s, triple bip au moment de partir
  if (mine && seconds !== null && seconds <= 50) {
    // Un seul bip par tranche de 10 s (50, 40… 10), joué dès qu'on y entre, puis la sirène à 0
    const step = Math.ceil(seconds / 10) * 10;
    const beepKey = `${mine.time.getTime()}|${step}`;
    if (beepKey !== lastBeep) {
      lastBeep = beepKey;
      playAlert(step === 0 ? "go" : step <= 20 ? "warn" : "tick");
    }
  }

  const advice = mine
    ? `Partez à ${formatTime(leaveAt)} pour le ${mineName ? `${MODES[mineName.mode] || ""} ${mineName.name}`.trim() : "train"} de ${formatTime(mine.time)}${mine.destination ? ` → ${mine.destination}` : ""}`
    : upcoming.length
      ? "Plus aucun train atteignable à temps pour l'instant"
      : wanted.length
        ? "Aucun passage vers ces destinations"
        : "Aucun passage annoncé";
  paint("advice", advice, (v) => ($("advice").textContent = v));
  // Simulation : temps restant avant que l'horloge reparte du début
  let status = statusText;
  if (simOffset) {
    const left = Math.ceil((SIM_DURATION_MS - simElapsed()) / 1000);
    status = `Simulation · reprise dans ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  }
  paint("status", status, (v) => ($("status").textContent = v));

  // Carte station + lien plan
  paint("stationCard", `${station.name}|${focusLine?.id}|${direction}`, () => {
    $("station-name").textContent = station.name;
    $("station-sub").textContent = focusLine
      ? `${MODES[focusLine.mode] || ""} ${focusLine.name}${station.line ? "" : " · toutes les lignes"} – ${direction}`
      : station.town || "";
  });

  renderStrip(focusLine, focus, nowMs);
}

// ---------------------------------------------------------------------------
// Schéma de ligne : gares autour de la station, train qui approche
// ---------------------------------------------------------------------------
const stripGeo = new Map(); // id de ligne -> géométrie | null ; absent = pas encore demandé

// Charge une fois le tracé et les gares d'une ligne, puis redessine
function ensureGeo(lineId) {
  if (!stripGeo.has(lineId)) {
    stripGeo.set(lineId, undefined);
    lineGeometry(lineId).then((geo) => {
      stripGeo.set(lineId, geo);
      delete drawn.strip;
      if (simOffset) loadTrains(); // terminus réels pour la simulation
      else render();
    });
  }
  return stripGeo.get(lineId);
}

// Position de notre station dans une liste de gares : même nom d'abord,
// sinon la gare la plus proche à moins de 300 m
function stationIndex(stops) {
  const norm = normalizeName(station.name);
  const exact = stops.findIndex((st) => normalizeName(st.name) === norm);
  if (exact !== -1) return exact;
  let best = -1;
  let bestDist = 300;
  stops.forEach((st, i) => {
    const d = distanceMeters(st, station);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

// Terminus réels d'une ligne vus depuis notre station : [[sens 1], [sens 2]]
function geoTermini(line) {
  const geo = stripGeo.get(line.id);
  if (!geo) return null;
  const parts = geo.ordered.filter((p) => p.stops.length >= 2);
  const withStation = parts.filter((p) => stationIndex(p.stops) !== -1);
  const pool = withStation.length ? withStation : parts;
  if (!pool.length) return null;
  const longest = pool.reduce((a, b) => (b.len > a.len ? b : a));
  return [[longest.stops[longest.stops.length - 1].name], [longest.stops[0].name]];
}

function stripModel(geo, destination) {
  let best = null;
  for (const part of geo.ordered) {
    const i = stationIndex(part.stops);
    if (i === -1) continue;
    const j = destination ? part.stops.findIndex((st) => sameDestination(st.name, destination)) : -1;
    const score = (j !== -1 ? 1000 : 0) + part.stops.length;
    if (!best || score > best.score) best = { part, i, j, score };
  }
  if (!best) return null;

  let stops = best.part.stops;
  let here = best.i;
  // Sens de marche : vers la destination (sinon vers le bout du tracé)
  let forward = true;
  if (best.j !== -1) forward = best.j > here;
  else if (destination && sameDestination(stops[0].name, destination)) forward = false;
  if (!forward) {
    stops = [...stops].reverse();
    here = stops.length - 1 - here;
  }
  const start = Math.max(0, here - 4);
  const end = Math.min(stops.length, here + 5);
  return { stops: stops.slice(start, end), here: here - start };
}

function renderStrip(line, focus, nowMs) {
  const el = $("strip");
  if (!line) return paint("strip", "none", () => (el.innerHTML = ""));

  const geo = ensureGeo(line.id);
  const model = geo && stripModel(geo, focus?.destination);
  if (!model) {
    const text = geo === undefined ? "Chargement du schéma de la ligne…" : "Schéma indisponible pour cette station";
    return paint("strip", text, (v) => (el.innerHTML = `<p class="strip-empty">${escapeHtml(v)}</p>`));
  }

  const n = model.stops.length;
  const xOf = (i) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const color = colorOf(line.id).bg;

  // Gares (redessinées seulement si la portion de ligne change)
  paint("strip", `${line.id}|${model.stops.map((s) => s.name).join(",")}|${color}`, () => {
    el.style.setProperty("--blue-2", color);
    el.innerHTML =
      '<div class="strip-track"></div><div class="strip-done" id="strip-done"></div>' +
      model.stops
        .map((st, i) => {
          const cls = i === model.here ? " here" : "";
          return (
            `<span class="strip-label${cls}" style="left:calc(${xOf(i)}% - 6px)">${escapeHtml(st.name)}</span>` +
            `<span class="strip-stop${cls}" data-i="${i}" style="left:${xOf(i)}%"></span>`
          );
        })
        .join("") +
      '<span class="strip-train" id="strip-train" hidden><svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M9 17l-2 4M15 17l2 4"/></svg></span>';
  });

  // Train qui approche : nombre de gares avant la nôtre selon son temps d'arrivée
  const coming = focus && trains.find((t) => t.time - nowMs > -30000 && t.lineId === focus.lineId && t.destination === focus.destination);
  const trainEl = $("strip-train");
  const done = $("strip-done");
  if (!coming || !trainEl) {
    if (trainEl) trainEl.hidden = true;
    if (done) done.style.width = "0";
    return;
  }
  const back = Math.max(0, (coming.time - nowMs) / 60000) / (MINUTES_PER_STOP[line.mode] || 2);
  const pos = Math.max(0, model.here - back);
  trainEl.hidden = false;
  trainEl.style.left = `${xOf(pos)}%`;
  trainEl.style.background = color;
  trainEl.style.color = colorOf(line.id).fg;
  trainEl.title = `${coming.destination} · ${minutesText(minutesUntil(coming, nowMs))}`;
  done.style.width = `${xOf(pos)}%`;
  el.querySelectorAll(".strip-stop").forEach((stop) => stop.classList.toggle("ahead", Number(stop.dataset.i) > pos && !stop.classList.contains("here")));
}

// ---------------------------------------------------------------------------
// Choix de la station, de la ligne et des destinations
// ---------------------------------------------------------------------------
function openPicker() {
  picker.hidden = false;
  $("picker-title").textContent = "Changer de station";
  pickerSearch.hidden = false;
  pickerSearch.value = "";
  pickerList.innerHTML = '<li class="hint">Tapez le nom d\'une station</li>';
  pickerSearch.focus();
}

function closePicker() {
  picker.hidden = true;
}

function showMessage(text) {
  pickerList.innerHTML = `<li class="hint">${escapeHtml(text)}</li>`;
}

let searchTimer = null;
pickerSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchStations, 300);
});

async function searchStations() {
  const q = pickerSearch.value.trim().replace(/["\\]/g, "");
  if (q.length < 2) return showMessage("Tapez le nom d'une station");

  const params = new URLSearchParams({
    select: "zdaid,arrname,arrtown,arrtype,arrgeopoint",
    where: `search(arrname, "${q}")`,
    limit: "100",
  });
  try {
    const { results = [] } = await (await fetch(`${OPENDATA_URL}/arrets/records?${params}`)).json();
    if (q !== pickerSearch.value.trim().replace(/["\\]/g, "")) return;
    const stations = groupStations(results).slice(0, 12);

    if (!stations.length) return showMessage("Aucune station trouvée");
    pickerList.innerHTML = stations
      .map((s, i) => {
        const types = [...s.types].map((t) => STOP_TYPES[t] || t).join(" · ");
        return (
          `<li><button type="button" data-i="${i}">` +
          `<strong>${escapeHtml(s.name)}</strong>` +
          `<small>${escapeHtml(types)} — ${escapeHtml(s.town)}</small></button></li>`
        );
      })
      .join("");
    pickerList.querySelectorAll("button").forEach((btn) =>
      btn.addEventListener("click", () => chooseStation(stations[btn.dataset.i]))
    );
  } catch {
    showMessage("Recherche impossible (réseau ?)");
  }
}

// Points d'arrêt (jeu de données « arrets ») -> stations :
// 1. regroupés par zone d'arrêt, 2. zones de même nom et proches fusionnées
// (ex. Saint-Ouen : métro + RER + bus). Les stations ferrées d'abord.
const stationRank = (s) => Math.min(...[...s.types].map((t) => STOP_TYPE_ORDER.indexOf(t)));

function groupStations(results) {
  const byZone = new Map();
  for (const r of results) {
    if (!byZone.has(r.zdaid)) {
      byZone.set(r.zdaid, {
        zdaid: r.zdaid,
        name: r.arrname,
        town: r.arrtown,
        lat: r.arrgeopoint?.lat,
        lon: r.arrgeopoint?.lon,
        types: new Set(),
      });
    }
    byZone.get(r.zdaid).types.add(r.arrtype);
  }
  const zones = [...byZone.values()].sort((a, b) => stationRank(a) - stationRank(b));

  const stations = [];
  for (const zone of zones) {
    const norm = normalizeName(zone.name);
    const same = stations.find((s) => s.norm === norm && distanceMeters(s, zone) < MERGE_METERS);
    if (same) {
      same.zdaids.push(zone.zdaid);
      zone.types.forEach((t) => same.types.add(t));
      if (zone.name.length < same.name.length) same.name = zone.name; // « Saint-Ouen » plutôt que « Saint-Ouen RER »
    } else {
      stations.push({ ...zone, norm, zdaids: [zone.zdaid], types: new Set(zone.types) });
    }
  }
  return stations;
}

// « Saint-Ouen RER » et « Saint-Ouen » -> « saint ouen »
function normalizeName(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s-]+rer$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Lignes desservant une zone d'arrêt : RER/Train référencés par la zone,
// métro/tram/bus par leurs points d'arrêt
async function fetchZoneLines(zdaid) {
  const stops = new URLSearchParams({ select: "arrid", where: `zdaid="${zdaid}"`, limit: "100" });
  const { results: points = [] } = await (await fetch(`${OPENDATA_URL}/arrets/records?${stops}`)).json();
  const ids = [`IDFM:monomodalStopPlace:${zdaid}`, ...points.map((p) => `IDFM:${p.arrid}`)];

  const params = new URLSearchParams({
    select: "id,shortname,mode",
    where: `stop_id in (${ids.map((id) => `"${id}"`).join(",")})`,
    group_by: "id,shortname,mode",
    limit: "100",
  });
  const { results = [] } = await (await fetch(`${OPENDATA_URL}/arrets-lignes/records?${params}`)).json();
  return results.map((l) => ({ id: lineCode(l.id), name: l.shortname, mode: l.mode }));
}

// Lignes de toutes les zones de la station ; chaque ligne retient ses zones
async function fetchLines(zdaids) {
  const perZone = await Promise.all(zdaids.map(fetchZoneLines));
  const byId = new Map();
  perZone.forEach((lines, i) =>
    lines.forEach((l) => {
      if (!byId.has(l.id)) byId.set(l.id, { ...l, zones: [] });
      byId.get(l.id).zones.push(zdaids[i]);
    })
  );
  return [...byId.values()].sort(
    (a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode) || a.name.localeCompare(b.name, "fr", { numeric: true })
  );
}

async function chooseStation(found) {
  const base = { zdaids: found.zdaids, name: found.name, town: found.town, lat: found.lat, lon: found.lon };
  pickerSearch.hidden = true;
  $("picker-title").textContent = found.name;
  showMessage("Chargement des lignes…");

  let lines = [];
  try {
    lines = await fetchLines(found.zdaids);
    await loadLineColors(lines.map((l) => l.id));
  } catch {
    // Sans la liste des lignes, on affiche tous les passages
  }

  // Une seule ligne : directement le choix des destinations
  if (lines.length <= 1) return showDestinationChoice({ ...base, lines, line: lines[0] || null, destinations: [] });

  // Plusieurs lignes ou transports : on laisse choisir
  showLineChoice({ ...base, lines, line: null, destinations: [] });
}

// Liste des lignes d'une station ; `current` = ligne actuellement affichée
function showLineChoice(target, current) {
  const options = [{ line: null, label: "Toutes les lignes" }].concat(
    target.lines.map((l) => ({ line: l, label: `${MODES[l.mode] || l.mode} ${l.name}` }))
  );
  const isCurrent = (o) => current !== undefined && (o.line?.id ?? null) === (current?.id ?? null);
  pickerList.innerHTML = options
    .map(
      (o, i) =>
        `<li><button type="button" class="line-option" data-i="${i}"${isCurrent(o) ? ' aria-current="true"' : ""}>` +
        `${o.line ? pairHtml(o.line) : '<span class="pair"><span class="mini-mode">•</span></span>'}` +
        `<strong>${escapeHtml(o.label)}</strong>${isCurrent(o) ? "<small>affichée</small>" : ""}</button></li>`
    )
    .join("");
  pickerList.querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", () => {
      const { line } = options[btn.dataset.i];
      if (!line) {
        applyStation({ ...target, line: null, destinations: [] });
        return closePicker();
      }
      // Même ligne qu'avant : on garde les destinations déjà cochées
      const destinations = target.line?.id === line.id ? target.destinations || [] : [];
      showDestinationChoice({ ...target, line, destinations });
    })
  );
}

// Toucher les pictogrammes : changer de ligne sans rechercher la station
function openLineChoice() {
  picker.hidden = false;
  pickerSearch.hidden = true;
  $("picker-title").textContent = `${station.name} · ligne`;
  showLineChoice(station, station.line);
}

// Destinations possibles : terminus connus + destinations vues en temps réel
async function destinationOptions(target) {
  const options = [];
  const add = (name, dir) => {
    if (!name || sameDestination(name, target.name)) return;
    if (!options.some((o) => sameDestination(o.name, name))) options.push({ name, dir });
  };
  const lines = target.line ? [target.line] : target.lines;
  lines.forEach((l) =>
    (SIM_TERMINI[`${l.mode}:${l.name}`] || geoTermini(l) || []).forEach((names, dir) => names.forEach((n) => add(n, dir)))
  );
  if (!simOffset) {
    try {
      (await fetchTrains(target)).forEach((t) => add(t.destination, 9));
    } catch {
      // Hors ligne : seulement les terminus connus
    }
  }
  return options.sort((a, b) => a.dir - b.dir || a.name.localeCompare(b.name, "fr"));
}

// Cases à cocher : aucune ou toutes cochées = toutes les destinations
async function showDestinationChoice(target) {
  picker.hidden = false;
  pickerSearch.hidden = true;
  const line = target.line;
  $("picker-title").textContent = line ? `${MODES[line.mode] || line.mode} ${line.name} · destinations` : `${target.name} · destinations`;
  showMessage("Chargement des destinations…");

  const options = await destinationOptions(target);
  const chosen = target.destinations || [];
  const isChecked = (o) => chosen.some((d) => sameDestination(d, o.name));

  pickerList.innerHTML =
    (options.length
      ? options
          .map(
            (o, i) =>
              `<li><label class="dest-option"><input type="checkbox" data-i="${i}"${isChecked(o) ? " checked" : ""}>` +
              `<strong>→ ${escapeHtml(o.name)}</strong></label></li>`
          )
          .join("")
      : '<li class="hint">Aucune destination connue pour le moment.</li>') +
    '<li class="dest-actions">' +
    '<button type="button" id="dest-all">Toutes les destinations</button>' +
    (options.length ? '<button type="button" id="dest-ok" class="primary">Valider</button>' : "") +
    "</li>";

  const apply = (destinations) => {
    applyStation({ ...target, destinations });
    closePicker();
  };
  $("dest-all").addEventListener("click", () => apply([]));
  $("dest-ok")?.addEventListener("click", () => {
    const selected = [...pickerList.querySelectorAll("input:checked")].map((input) => options[input.dataset.i].name);
    apply(selected.length === options.length ? [] : selected);
  });
}

// ---------------------------------------------------------------------------
// Stations à proximité du point de départ (rayon réglable, à vol d'oiseau)
// ---------------------------------------------------------------------------
const TABLE_URL = "https://routing.openstreetmap.de/routed-foot/table/v1/foot";
const WALK_M_PER_MIN = 75; // 4,5 km/h
const NEARBY_MAX = 12; // stations par catégorie
const NEARBY_MAX_METERS = 3000;
const nearby = { origin: null, radius: null, list: null, loading: false, error: "" };
const stationLinesCache = new Map(); // zones de la station -> lignes (null = en cours)
let nearbyRequest = 0; // numéro de la dernière recherche : les réponses plus anciennes sont ignorées

async function loadNearby(force = false) {
  const origin = lastOrigin;
  if (!origin) return renderNearby();
  const sameSearch = nearby.origin && nearby.radius === settings.nearbyMeters && distanceMeters(origin, nearby.origin) < 50;
  if (sameSearch && !force) return;

  const request = ++nearbyRequest;
  const radius = settings.nearbyMeters;
  Object.assign(nearby, { origin, radius, loading: true, error: "" });
  renderNearby();
  busy(1);
  try {
    // 1. Pour chaque catégorie, les arrêts les plus proches dans le rayon
    //    (une recherche par catégorie : sinon les arrêts de bus noient métro et RER)
    const point = `geom'POINT(${origin.lon} ${origin.lat})'`;
    const perCategory = await Promise.all(
      NEARBY_CATEGORIES.map(async (cat) => {
        const params = new URLSearchParams({
          select: "zdaid,arrname,arrtown,arrtype,arrgeopoint",
          where: `within_distance(arrgeopoint, ${point}, ${radius}m) and arrtype in (${cat.types.map((t) => `"${t}"`).join(",")})`,
          order_by: `distance(arrgeopoint, ${point})`,
          limit: "100",
        });
        const { results = [] } = await (await fetch(`${OPENDATA_URL}/arrets/records?${params}`)).json();
        return results;
      })
    );
    const rows = perCategory.flat().filter((r) => r.arrgeopoint);

    // 2. Stations ; distance = celle de leur arrêt le plus proche
    const stations = groupStations(rows);
    for (const s of stations) {
      let best = null;
      for (const r of rows) {
        if (!s.zdaids.includes(r.zdaid)) continue;
        const d = distanceMeters(origin, r.arrgeopoint);
        if (!best || d < best.d) best = { d, lat: r.arrgeopoint.lat, lon: r.arrgeopoint.lon };
      }
      s.meters = best.d;
      s.near = best; // on marche jusqu'à l'arrêt le plus proche
    }
    // Les plus proches de chaque catégorie (une station peut compter dans plusieurs)
    const picked = new Set();
    NEARBY_CATEGORIES.forEach((cat) =>
      stations
        .filter((s) => cat.types.some((t) => s.types.has(t)))
        .sort((a, b) => a.meters - b.meters)
        .slice(0, NEARBY_MAX)
        .forEach((s) => picked.add(s))
    );
    const candidates = [...picked];

    // 3. Temps de marche réels vers toutes ces stations en une requête (OSRM « table »)
    let durations = null;
    let distances = null;
    if (candidates.length) {
      try {
        const coords = [origin, ...candidates.map((s) => s.near)].map((p) => `${p.lon},${p.lat}`).join(";");
        const data = await (await fetch(`${TABLE_URL}/${coords}?sources=0&annotations=duration,distance`)).json();
        durations = data.durations?.[0];
        distances = data.distances?.[0];
      } catch {
        // Estimation à vol d'oiseau ci-dessous
      }
    }
    candidates.forEach((s, i) => {
      const walked = distances?.[i + 1] ?? s.meters * 1.3;
      const seconds = durations?.[i + 1] ?? walked / (WALK_M_PER_MIN / 60);
      s.walk = Math.max(1, Math.ceil(seconds / 60));
    });
    if (request !== nearbyRequest) return; // une recherche plus récente a été lancée
    nearby.list = candidates.sort((a, b) => a.walk - b.walk || a.meters - b.meters);
  } catch {
    if (request !== nearbyRequest) return;
    nearby.error = "Recherche des stations impossible (réseau ?)";
  } finally {
    busy(-1);
  }
  nearby.loading = false;
  renderNearby();
}
const formatMeters = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace(".", ",")} km` : `${Math.round(m / 10) * 10} m`);

// Trois catégories : types d'arrêts (jeu « arrets ») et modes de lignes (jeu « arrets-lignes »)
const NEARBY_CATEGORIES = [
  { key: "metro", title: "Métro", types: ["metro"], modes: ["Metro"] },
  {
    key: "rail",
    title: "RER · Tram · Train",
    types: ["rail", "tram", "funicular"],
    modes: ["RapidTransit", "LocalTrain", "Train", "Tramway", "Funicular", "CableWay"],
  },
  { key: "bus", title: "Bus", types: ["bus"], modes: ["Bus"] },
];

function lineBadge(l) {
  const c = colorOf(l.id);
  return (
    `<span class="mini-line${isRect(l.mode) ? " rect" : ""}" style="background:${c.bg};color:${c.fg}" ` +
    `title="${escapeHtml(`${MODES[l.mode] || ""} ${l.name}`)}">${escapeHtml(l.name)}</span>`
  );
}

function renderNearby() {
  const listEl = $("nearby-list");
  // Recherche en cours : indicateur + liste estompée jusqu'aux nouveaux résultats
  document.querySelector(".nearby").classList.toggle("is-loading", nearby.loading && !!lastOrigin);
  const from = settings.origin === "address" && settings.address ? `de ${settings.address.label}` : "de votre position";
  $("nearby-sub").textContent = `dans un rayon de ${formatMeters(settings.nearbyMeters)} ${from}`;
  if (document.activeElement !== $("radius-range")) showRadius(settings.nearbyMeters);

  const hint = (html) => (listEl.innerHTML = `<p class="hint">${html}</p>`);
  if (!lastOrigin) {
    return hint('Indiquez votre adresse de départ dans les <a href="#reglages">Réglages</a> pour voir les stations proches.');
  }
  if (nearby.error) return hint(escapeHtml(nearby.error));
  if (!nearby.list) {
    // Premier chargement : vignettes fantômes dans les trois colonnes
    const ghost = '<li><div class="nearby-item skeleton"><span></span><span></span><span></span></div></li>';
    listEl.innerHTML = NEARBY_CATEGORIES.map(
      (cat) => `<section class="nearby-cat"><h3>${cat.title}</h3><ul class="nearby-list">${ghost.repeat(3)}</ul></section>`
    ).join("");
    return;
  }

  const currentZones = zonesOf(station);
  const shown = []; // stations affichées (pour charger leurs lignes)

  listEl.innerHTML = NEARBY_CATEGORIES.map((cat) => {
    const stations = nearby.list.filter((s) => cat.types.some((t) => s.types.has(t))).slice(0, NEARBY_MAX);
    const items = stations
      .map((s) => {
        const i = shown.push(s) - 1;
        const current = s.zdaids.some((z) => currentZones.includes(z));
        const lines = stationLinesCache.get(s.zdaids.join(","));
        // Seulement les lignes de la catégorie
        const own = lines ? lines.filter((l) => cat.modes.includes(l.mode)) : [];
        const badges = own.slice(0, 8).map(lineBadge).join("") + (own.length > 8 ? `<span class="more">+${own.length - 8}</span>` : "");
        return (
          `<li><button type="button" class="nearby-item${current ? " current" : ""}" data-i="${i}">` +
          `<span class="nearby-top"><span class="nearby-name">${escapeHtml(s.name)}</span><span class="nearby-walk">${s.walk} min</span></span>` +
          `<span class="nearby-meta">${escapeHtml(`à ${formatMeters(s.meters)}${current ? " · station actuelle" : ""}`)}</span>` +
          `<span class="nearby-lines">${badges}</span></button></li>`
        );
      })
      .join("");
    return (
      `<section class="nearby-cat"><h3>${cat.title}<span class="count">${stations.length}</span></h3>` +
      (items ? `<ul class="nearby-list">${items}</ul>` : `<p class="empty">Aucune station dans ce rayon</p>`) +
      "</section>"
    );
  }).join("");

  listEl.querySelectorAll(".nearby-item").forEach((btn) =>
    btn.addEventListener("click", () => {
      picker.hidden = false;
      chooseStation(shown[btn.dataset.i]); // choix de la ligne puis des destinations
    })
  );

  // Lignes de chaque station, chargées une seule fois
  shown.forEach((s) => {
    const key = s.zdaids.join(",");
    if (stationLinesCache.has(key)) return;
    stationLinesCache.set(key, null);
    fetchLines(s.zdaids)
      .then(async (lines) => {
        stationLinesCache.set(key, lines);
        await loadLineColors(lines.map((l) => l.id));
        scheduleNearbyRender();
      })
      .catch(() => stationLinesCache.delete(key));
  });
}
// Plusieurs stations reçoivent leurs lignes en même temps : un seul rendu
let nearbyRenderQueued = false;
function scheduleNearbyRender() {
  if (nearbyRenderQueued) return;
  nearbyRenderQueued = true;
  requestAnimationFrame(() => {
    nearbyRenderQueued = false;
    renderNearby();
  });
}



// ---------------------------------------------------------------------------
// Page Réglages : point de départ, marge, station
// ---------------------------------------------------------------------------
const GEOCODE_URL = "https://data.geopf.fr/geocodage/search";

function renderSettings() {
  document.querySelectorAll('input[name="origin"]').forEach((r) => (r.checked = r.value === settings.origin));
  $("address-box").hidden = settings.origin !== "address";
  $("saved-address").innerHTML = settings.address
    ? `Adresse enregistrée : <strong>${escapeHtml(settings.address.label)}</strong>`
    : "Aucune adresse enregistrée : cherchez-la ci-dessus.";
  $("walk-result").textContent = `Trajet jusqu'à ${station.name} : ${walkLabel}`;
  $("margin-value").textContent = `${marginMinutes()} min`;
  $("radius-value").textContent = formatMeters(settings.nearbyMeters);
  renderFavs();
  renderFavSettings();
}

// Un réglage a changé : on l'enregistre et toute l'application se met à jour
// (passages, compte à rebours, trajet, stations proches, météo)
function settingsChanged({ origin = false } = {}) {
  saveSettings();
  if (origin) startOrigin(); // nouveau point de départ : trajet et stations proches recalculés
  else walkLabel = walkText(walkLabel.split(" · ")[1] || "estimation");
  drawn = {};
  render();
  renderSettings();
  renderNearby();
  renderSound();
  loadTrains();
  loadWeather();
  if (lastOrigin) loadNearby(true);
}

document.querySelectorAll('input[name="origin"]').forEach((radio) =>
  radio.addEventListener("change", () => {
    settings.origin = radio.value;
    settingsChanged({ origin: true });
    if (radio.value === "address" && !settings.address) $("address-input").focus();
  })
);
// Recherche d'adresse (Géoplateforme IGN, sans clé), favorisant les adresses proches de la station
let addressTimer = null;
$("address-input").addEventListener("input", () => {
  clearTimeout(addressTimer);
  addressTimer = setTimeout(searchAddress, 250);
});

async function searchAddress() {
  const q = $("address-input").value.trim();
  const list = $("address-suggestions");
  if (q.length < 3) return (list.innerHTML = "");
  const params = new URLSearchParams({ q, limit: "5", autocomplete: "1" });
  if (station.lat != null) {
    params.set("lat", station.lat);
    params.set("lon", station.lon);
  }
  try {
    const { features = [] } = await (await fetch(`${GEOCODE_URL}?${params}`)).json();
    if (q !== $("address-input").value.trim()) return;
    if (!features.length) return (list.innerHTML = '<li class="hint">Aucune adresse trouvée</li>');
    list.innerHTML = features
      .map(
        (f, i) =>
          `<li><button type="button" data-i="${i}"><strong>${escapeHtml(f.properties.label)}</strong>` +
          `<small>${escapeHtml(f.properties.context || "")}</small></button></li>`
      )
      .join("");
    list.querySelectorAll("button").forEach((btn) =>
      btn.addEventListener("click", () => {
        const f = features[btn.dataset.i];
        const [lon, lat] = f.geometry.coordinates;
        settings.address = { label: f.properties.label, lat, lon };
        $("address-input").value = "";
        list.innerHTML = "";
        settingsChanged({ origin: true });
      })
    );
  } catch {
    list.innerHTML = '<li class="hint">Recherche impossible (réseau ?)</li>';
  }
}

function setMargin(delta) {
  settings.margin = Math.max(0, Math.min(20, marginMinutes() + delta));
  settingsChanged();
}
$("margin-minus").addEventListener("click", () => setMargin(-1));
$("margin-plus").addEventListener("click", () => setMargin(1));

// Rayon des stations proches : de 100 m à 3 km, par pas de 100 m
function setRadius(delta) {
  settings.nearbyMeters = Math.max(100, Math.min(NEARBY_MAX_METERS, settings.nearbyMeters + delta));
  settingsChanged();
}
// Curseur de rayon sur la page Station : affichage immédiat, recherche quand on s'arrête
function showRadius(meters) {
  const range = $("radius-range");
  range.value = meters;
  range.style.setProperty("--fill", `${((meters - range.min) / (range.max - range.min)) * 100}%`);
  $("radius-live").textContent = formatMeters(meters);
}
let radiusTimer = null;
$("radius-range").addEventListener("input", (event) => {
  const meters = Number(event.target.value);
  showRadius(meters);
  clearTimeout(radiusTimer);
  radiusTimer = setTimeout(() => {
    settings.nearbyMeters = meters;
    settingsChanged();
  }, 350);
});

$("radius-minus").addEventListener("click", () => setRadius(-100));
$("radius-plus").addEventListener("click", () => setRadius(100));

// ---------------------------------------------------------------------------
// Alertes sonores (Web Audio, sans fichier son)
// Les navigateurs n'autorisent le son qu'après un premier geste sur la page.
// ---------------------------------------------------------------------------
let audioCtx = null;
function audioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!audioCtx && AC) audioCtx = new AC();
  return audioCtx;
}
function unlockAudio() {
  const ctx = audioContext();
  if (ctx && ctx.state === "suspended") ctx.resume();
}
document.addEventListener("pointerdown", unlockAudio, { passive: true });
document.addEventListener("keydown", unlockAudio);

// Une note : onde carrée (son d'alarme), fréquence éventuellement glissante
function tone(ctx, start, duration, freq, freqEnd = freq, volume = 0.18) {
  // Volume réglable : 70 % (par défaut) = niveau d'origine, 100 % un peu plus fort
  volume = Math.max(0.0002, volume * (settings.volume / 70));
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(freq, start);
  if (freqEnd !== freq) osc.frequency.linearRampToValueAtTime(freqEnd, start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
  gain.gain.setValueAtTime(volume, start + duration - 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

// Alertes de plus en plus pressantes :
//  « tick » (50, 40, 30 s) : double bip
//  « warn » (20, 10 s)     : triple bip plus aigu et plus rapide
//  « go »   (0 s)          : sirène deux tons, il faut partir
function playAlert(kind) {
  if (!settings.sound || !settings.volume) return;
  const ctx = audioContext();
  if (!ctx || ctx.state !== "running") return;
  const t = ctx.currentTime + 0.02;
  if (kind === "tick") {
    tone(ctx, t, 0.09, 1000);
    tone(ctx, t + 0.14, 0.09, 1000);
  } else if (kind === "warn") {
    for (let i = 0; i < 3; i++) tone(ctx, t + i * 0.11, 0.07, 1400);
  } else {
    // Sirène : alternance rapide 960 / 1440 Hz, puis montée finale
    for (let i = 0; i < 6; i++) tone(ctx, t + i * 0.16, 0.15, i % 2 ? 1440 : 960, undefined, 0.22);
    tone(ctx, t + 0.98, 0.45, 900, 1800, 0.22);
  }
}

const SOUND_ON = '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>';
const SOUND_OFF = '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6"/>';
function renderSound() {
  const btn = $("sound");
  btn.setAttribute("aria-pressed", settings.sound);
  btn.title = settings.sound ? "Alertes sonores activées" : "Alertes sonores coupées";
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${settings.sound ? SOUND_ON : SOUND_OFF}</svg>`;
  document.querySelectorAll('input[name="sound"]').forEach((r) => (r.checked = (r.value === "on") === settings.sound));
  showVolume(settings.volume);
}

// Curseur de volume : affichage immédiat, bip de test quand on relâche
function showVolume(value) {
  const range = $("volume-range");
  range.value = value;
  range.style.setProperty("--fill", `${value}%`);
  range.disabled = !settings.sound;
  $("volume-value").textContent = value ? `${value} %` : "muet";
}
$("volume-range").addEventListener("input", (event) => {
  settings.volume = Number(event.target.value);
  showVolume(settings.volume);
  saveSettings();
});
$("volume-range").addEventListener("change", () => {
  unlockAudio();
  setTimeout(() => playAlert("tick"), 50);
});
function setSound(on) {
  settings.sound = on;
  unlockAudio();
  settingsChanged();
  if (on) setTimeout(() => playAlert("tick"), 50); // petit bip de test
}
$("sound").addEventListener("click", () => setSound(!settings.sound));
document.querySelectorAll('input[name="sound"]').forEach((radio) =>
  radio.addEventListener("change", () => setSound(radio.value === "on"))
);

// ---------------------------------------------------------------------------
// Info trafic (PRIM « disruptions_bulk ») : perturbations des lignes de la station
// ---------------------------------------------------------------------------
const TRAFFIC_REFRESH_MS = 5 * 60000;
const UPCOMING_DAYS = 7;
const SEVERITY = {
  BLOQUANTE: { label: "Bloquant", cls: "blocking", rank: 0 },
  PERTURBEE: { label: "Perturbé", cls: "disrupted", rank: 1 },
  INFORMATION: { label: "Information", cls: "info", rank: 2 },
};
let trafficByLine = null; // id de ligne -> [{ d, stops: Set(id d'arrêt) }]
let trafficError = false;
let showUpcoming = false;
let trafficAlert = null; // perturbation en cours qui concerne votre trajet

async function loadTraffic() {
  busy(1);
  try {
    // Messages en français, quelle que soit la langue du navigateur
    const res = await primFetch("disruptions_bulk/disruptions/v2", "", { "Accept-Language": "fr" });
    if (!res.ok) throw new Error(`PRIM ${res.status}`);
    const data = await res.json();
    const byId = new Map((data.disruptions || []).map((d) => [d.id, d]));
    trafficByLine = new Map();
    for (const line of data.lines || []) {
      const entries = new Map();
      for (const obj of line.impactedObjects || []) {
        for (const id of obj.disruptionIds || []) {
          const d = byId.get(id);
          if (!d) continue;
          if (!entries.has(id)) entries.set(id, { d, stops: new Set() });
          // "stop_point:IDFM:monomodalStopPlace:43230" -> "43230" (zone d'arrêt)
          if (obj.type !== "line") entries.get(id).stops.add(lineCode(obj.id));
        }
      }
      trafficByLine.set(lineCode(line.id), [...entries.values()]);
    }
    trafficError = false;
  } catch {
    trafficError = true;
  } finally {
    busy(-1);
  }
  renderTraffic();
}

// "20261024T030000" -> Date (heure de Paris)
const parsePrimDate = (s) =>
  new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`);

// Perturbations en cours ou dans les 7 prochains jours, sur les lignes affichées
function stationDisruptions() {
  if (!trafficByLine) return [];
  const t = now();
  const zones = new Set(zonesOf(station));
  const seen = new Set();
  const list = [];
  for (const line of station.line ? [station.line] : station.lines) {
    for (const { d, stops } of trafficByLine.get(line.id) || []) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const periods = (d.applicationPeriods || []).map((p) => [parsePrimDate(p.begin), parsePrimDate(p.end)]);
      const current = periods.find(([b, e]) => b <= t && t < e);
      const next = periods.filter(([b]) => b > t).sort((a, b) => a[0] - b[0])[0];
      if (!current && (!next || next[0] - t > UPCOMING_DAYS * 86400000)) continue;
      list.push({
        d,
        line,
        active: !!current,
        end: current?.[1],
        next: next?.[0],
        here: [...stops].some((s) => zones.has(s)), // votre station est concernée
        severity: SEVERITY[d.severity] || SEVERITY.INFORMATION,
      });
    }
  }
  return list.sort(
    (a, b) => b.active - a.active || b.here - a.here || a.severity.rank - b.severity.rank || (a.next || 0) - (b.next || 0)
  );
}

const formatDay = (date) =>
  date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" }) + ` ${formatTime(date)}`;

// Texte simple à partir du message HTML de PRIM (sans exécuter de HTML)
const htmlToText = (html) => new DOMParser().parseFromString(html || "", "text/html").body.textContent.trim();

function renderTraffic() {
  const el = $("traffic");
  const lines = station.line ? [station.line] : station.lines;
  const lineLabel = lines.map((l) => `${MODES[l.mode] || ""} ${l.name}`.trim()).join(", ") || station.name;
  if (trafficError && !trafficByLine) {
    el.className = "traffic level-unknown";
    el.innerHTML = `<div class="traffic-head"><strong>Info trafic indisponible</strong></div>`;
    trafficAlert = null;
    return;
  }
  if (!trafficByLine) {
    el.className = "traffic level-unknown";
    el.innerHTML = `<div class="traffic-head"><span class="spinner on"></span><strong>Info trafic · ${escapeHtml(lineLabel)}</strong></div>`;
    return;
  }

  const all = stationDisruptions();
  const active = all.filter((x) => x.active);
  const upcoming = all.filter((x) => !x.active);
  const worst = active.length ? active.reduce((a, b) => (b.severity.rank < a.severity.rank ? b : a)).severity.cls : "ok";

  // Alerte dans « Votre train » : votre station touchée, ou ligne bloquée
  trafficAlert = active.find((x) => x.here && x.severity.rank <= 1) || active.find((x) => x.severity.cls === "blocking") || null;

  const item = (x) => {
    const when = x.active
      ? x.end
        ? `jusqu'à ${x.end - now() < 86400000 ? formatTime(x.end) : formatDay(x.end)}`
        : "en cours"
      : `à partir de ${formatDay(x.next)}`;
    const text = htmlToText(x.d.message);
    return (
      `<li class="sev-${x.severity.cls}">` +
      `<span class="sev">${x.severity.label}</span>` +
      `<div class="traffic-body"><strong>${escapeHtml(x.d.title)}</strong>` +
      `<small>${escapeHtml([x.d.shortMessage, when].filter(Boolean).join(" · "))}${x.here ? ' · <b class="here">Votre station</b>' : ""}</small>` +
      (text ? `<details><summary>Détails</summary><p>${escapeHtml(text)}</p></details>` : "") +
      `</div></li>`
    );
  };

  const summary = active.length
    ? `${active.length} perturbation${active.length > 1 ? "s" : ""} en cours`
    : "Trafic normal";
  el.className = `traffic level-${worst}`;
  el.innerHTML =
    `<div class="traffic-head">` +
    `<span class="traffic-icon" aria-hidden="true">${active.length ? "!" : "✓"}</span>` +
    `<strong>Info trafic · ${escapeHtml(lineLabel)}</strong>` +
    `<span class="traffic-sum">${summary}</span>` +
    (upcoming.length
      ? `<button type="button" class="traffic-toggle" id="traffic-toggle" aria-expanded="${showUpcoming}">` +
        `${showUpcoming ? "Masquer" : "Voir"} les travaux à venir (${upcoming.length})</button>`
      : "") +
    `</div>` +
    (active.length ? `<ul class="traffic-list">${active.map(item).join("")}</ul>` : "") +
    (showUpcoming && upcoming.length ? `<ul class="traffic-list upcoming">${upcoming.map(item).join("")}</ul>` : "");

  $("traffic-toggle")?.addEventListener("click", () => {
    showUpcoming = !showUpcoming;
    renderTraffic();
  });
  delete drawn.trafficAlert;
}

// ---------------------------------------------------------------------------
// Trajets favoris et routines (bascule automatique selon l'heure)
// ---------------------------------------------------------------------------
const favKey = (s) => `${stationKey(s)}|${s.line?.id || ""}|${(s.destinations || []).join(",")}`;
const toMinutes = (hhmm) => {
  const [h, m] = (hhmm || "").split(":").map(Number);
  return h * 60 + m;
};
// Tranche horaire, éventuellement à cheval sur minuit (22:00–02:00)
function inWindow(mins, from, to) {
  if (!from || !to) return false;
  const a = toMinutes(from);
  const b = toMinutes(to);
  return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
}

let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

function renderFavs() {
  const favs = settings.favorites;
  const current = favKey(station);
  const saved = favs.some((f) => favKey(f.station) === current);
  $("favs").innerHTML =
    favs
      .map(
        (f, i) =>
          `<button type="button" class="fav-chip${favKey(f.station) === current ? " active" : ""}" data-i="${i}">` +
          `${f.station.line ? pairHtml(f.station.line) : ""}<span class="fav-name">${escapeHtml(f.name)}</span>` +
          `${f.from && f.to ? `<small>${f.from}–${f.to}</small>` : ""}</button>`
      )
      .join("") +
    `<button type="button" class="fav-chip add" id="fav-add">${saved ? "★ Trajet enregistré" : "☆ Enregistrer ce trajet"}</button>`;
}

$("favs").addEventListener("click", (event) => {
  const chip = event.target.closest(".fav-chip");
  if (!chip) return;
  if (chip.id === "fav-add") {
    const saved = settings.favorites.some((f) => favKey(f.station) === favKey(station));
    if (saved) location.hash = "#reglages"; // déjà enregistré : on le gère dans les réglages
    else openFavDialog();
    return;
  }
  const fav = settings.favorites[chip.dataset.i];
  applyStation(structuredClone(fav.station));
  toast(`Trajet « ${fav.name} »`);
});

// Nom proposé : « Les Grésillons · RER C → Pontoise »
function defaultFavName() {
  const line = station.line ? `${MODES[station.line.mode] || ""} ${station.line.name}`.trim() : "toutes lignes";
  const dest = station.destinations?.length ? ` → ${station.destinations.join(", ")}` : "";
  return `${station.name} · ${line}${dest}`;
}

function openFavDialog() {
  picker.hidden = false;
  pickerSearch.hidden = true;
  $("picker-title").textContent = "Enregistrer ce trajet";
  pickerList.innerHTML =
    '<li class="fav-form">' +
    `<label>Nom<input type="text" class="text-input" id="fav-name" maxlength="60" value="${escapeHtml(defaultFavName())}"></label>` +
    '<p class="muted">Activer ce trajet automatiquement entre (facultatif) :</p>' +
    '<div class="time-row"><input type="time" class="text-input" id="fav-from" aria-label="Début">' +
    '<span>et</span><input type="time" class="text-input" id="fav-to" aria-label="Fin"></div>' +
    '<button type="button" class="btn" id="fav-save">Enregistrer</button>' +
    "</li>";
  $("fav-name").select();
  $("fav-save").addEventListener("click", () => {
    const from = $("fav-from").value;
    const to = $("fav-to").value;
    settings.favorites.push({
      id: Date.now().toString(36),
      name: $("fav-name").value.trim() || defaultFavName(),
      station: structuredClone(station),
      from: from && to ? from : "",
      to: from && to ? to : "",
    });
    closePicker();
    settingsChanged();
    toast("Trajet enregistré");
  });
}

function renderFavSettings() {
  const favs = settings.favorites;
  paint("favSettings", JSON.stringify(favs.map((f) => [f.id, f.name, f.from, f.to])), () => {
    $("fav-settings").innerHTML = favs.length
      ? favs
          .map(
            (f, i) =>
              `<li class="fav-row">` +
              `<span class="fav-row-name">${f.station.line ? pairHtml(f.station.line) : ""}<strong>${escapeHtml(f.name)}</strong></span>` +
              `<span class="fav-row-time">` +
              `<input type="time" class="text-input" data-i="${i}" data-k="from" value="${f.from || ""}" aria-label="Début de la tranche horaire">` +
              `<span>–</span>` +
              `<input type="time" class="text-input" data-i="${i}" data-k="to" value="${f.to || ""}" aria-label="Fin de la tranche horaire">` +
              `</span>` +
              `<button type="button" class="fav-del" data-del="${i}" aria-label="Supprimer ${escapeHtml(f.name)}">×</button>` +
              `</li>`
          )
          .join("")
      : '<li class="hint">Aucun trajet. Utilisez « ☆ Enregistrer ce trajet » en haut de la page.</li>';
  });
  $("auto-routine").checked = settings.autoRoutine;
}

$("fav-settings").addEventListener("change", (event) => {
  const input = event.target.closest("input[data-k]");
  if (!input) return;
  settings.favorites[input.dataset.i][input.dataset.k] = input.value;
  autoFavState = undefined; // la nouvelle tranche horaire s'applique tout de suite
  settingsChanged();
});
$("fav-settings").addEventListener("click", (event) => {
  const del = event.target.closest("[data-del]");
  if (!del) return;
  settings.favorites.splice(Number(del.dataset.del), 1);
  settingsChanged();
});
$("auto-routine").addEventListener("change", (event) => {
  settings.autoRoutine = event.target.checked;
  autoFavState = undefined;
  settingsChanged();
});

// Bascule automatique : en entrant dans la tranche horaire d'un favori
// (un choix manuel n'est pas écrasé tant qu'on reste dans la même tranche)
let autoFavState; // id du favori de la tranche en cours (undefined = pas encore vérifié)
function checkRoutine() {
  if (!settings.autoRoutine) return;
  const d = new Date(now());
  const mins = d.getHours() * 60 + d.getMinutes();
  const fav = settings.favorites.find((f) => inWindow(mins, f.from, f.to));
  const id = fav?.id || null;
  if (id === autoFavState) return;
  autoFavState = id;
  if (fav && favKey(fav.station) !== favKey(station)) {
    applyStation(structuredClone(fav.station));
    toast(`Trajet « ${fav.name} » activé (${fav.from}–${fav.to})`);
  }
}

// ---------------------------------------------------------------------------
// Navigation : « Réglages » fait défiler jusqu'au panneau de la colonne de droite
// et le met brièvement en évidence ; « Station » remonte en haut
// ---------------------------------------------------------------------------
function showView() {
  const view = location.hash === "#reglages" ? "settings" : location.hash.startsWith("#itineraire") ? "itinerary" : "station";
  document.querySelectorAll(".tab").forEach((tab) => {
    if (tab.dataset.view === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  // Page Itinéraire à part ; Station et Réglages partagent la même page
  $("itineraire").hidden = view !== "itinerary";
  $("station").hidden = view === "itinerary";
  if (view === "itinerary") {
    window.scrollTo(0, 0);
    window.onItineraryOpen?.();
    return;
  }
  if (view === "settings") {
    const panel = $("reglages");
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    panel.classList.remove("flash");
    void panel.offsetWidth; // relance l'animation
    panel.classList.add("flash");
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}
window.addEventListener("hashchange", showView);
// Lien vers la section déjà affichée : pas de « hashchange », on relance quand même
document.querySelectorAll('a[href="#reglages"], a[href="#station"]').forEach((link) =>
  link.addEventListener("click", () => {
    if (link.getAttribute("href") === location.hash) setTimeout(showView);
  })
);

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------
$("hero-badges").addEventListener("click", () => {
  if (station.lines.length > 1) openLineChoice();
});
$("direction-btn").addEventListener("click", () => showDestinationChoice(station));
$("station-btn").addEventListener("click", openPicker);
$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
$("picker-close").addEventListener("click", closePicker);
picker.addEventListener("click", (event) => {
  if (event.target === picker) closePicker();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !picker.hidden) closePicker();
});

// Garder l'écran du téléphone allumé (si le navigateur le permet)
async function keepAwake() {
  try {
    await navigator.wakeLock?.request("screen");
  } catch {
    // Non supporté ou refusé : sans importance
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepAwake();
});
keepAwake();

showView();
renderSound();
startOrigin();
loadTrains();
loadWeather();
loadLineColors(station.lines.map((l) => l.id)).then(() => ((drawn = {}), render()));
loadTraffic();
loadLineColors(settings.favorites.map((f) => f.station.line?.id).filter(Boolean)).then(() => {
  delete drawn.favSettings; // redessiner avec les bonnes couleurs de ligne
  renderSettings();
});
setInterval(loadTraffic, TRAFFIC_REFRESH_MS);
setInterval(renderTraffic, 60000); // une perturbation peut commencer ou finir
setInterval(loadTrains, CONFIG.refreshMs);
setInterval(loadWeather, CONFIG.weatherRefreshMs);
setInterval(render, TICK_MS);
