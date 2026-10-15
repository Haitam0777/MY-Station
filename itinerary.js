// ---------------------------------------------------------------------------
// Page Itinéraire : calculateur Île-de-France Mobilités (PRIM / Navitia)
// Réutilise les outils de script.js (now, settings, station, applyStation…)
// ---------------------------------------------------------------------------
const IT_MODE_URIS = {
  metro: ["physical_mode:Metro"],
  rail: ["physical_mode:RapidTransit", "physical_mode:LocalTrain", "physical_mode:Train"],
  tram: ["physical_mode:Tramway"],
  bus: ["physical_mode:Bus"],
};
const IT_RECENT_MAX = 5;
const PLACE_KINDS = {
  stop_area: { label: "Station", icon: "🚉" },
  address: { label: "Adresse", icon: "📍" },
  poi: { label: "Lieu", icon: "★" },
  administrative_region: { label: "Ville", icon: "🏙" },
  coord: { label: "Position", icon: "📍" },
};
const WALK_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="M10 21l2-6 3 3v3M9 12l2-4 4 2 2 3M11 8l-3 3-2 1"/></svg>';

const it = {
  from: null, // { id, name, kind, lat, lon }
  to: null,
  activeField: "from",
  journeys: [],
  walkOnly: null,
  disruptions: new Map(),
  carCo2: null,
  selected: 0,
  loading: false,
  error: "",
  searched: false,
};

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------
async function navitia(path, params) {
  const res = await primFetch(`v2/navitia/${path}`, params, { "Accept-Language": "fr" });
  if (!res.ok) {
    let message = `erreur ${res.status}`;
    try {
      const body = await res.json();
      message = body.error?.id === "no_solution" ? "no_solution" : body.error?.message || body.message || message;
    } catch {
      // Réponse sans détail
    }
    throw new Error(message);
  }
  return res.json();
}

const pad2 = (n) => String(n).padStart(2, "0");
const toNavitiaDate = (d) =>
  `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
const toInputDate = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const navDate = (s) => (s ? parsePrimDate(s) : null); // même format que PRIM : 20261015T053000

// Émissions : en grammes sous 1 kg
const formatCo2 = (grams) =>
  grams < 1000 ? `${Math.round(grams)} g CO₂` : `${(grams / 1000).toFixed(1).replace(".", ",")} kg CO₂`;

function formatDuration(seconds) {
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${pad2(min % 60)}`;
}

// « Châtelet (Paris) » -> « Châtelet »
const cleanName = (name) => (name || "").replace(/\s*\([^)]*\)\s*$/, "");

// Référence Navitia d'un lieu : identifiant, sinon coordonnées « lon;lat »
const placeRef = (p) => (p.id && !p.id.includes(";") ? p.id : `${p.lon};${p.lat}`);
const coordPlace = (name, lat, lon, kind = "coord") => ({ id: `${lon};${lat}`, name, kind, lat, lon });

function placeFromNavitia(p) {
  const coord = p[p.embedded_type]?.coord || p.coord;
  if (!coord) return null;
  return { id: p.id, name: p.name, kind: p.embedded_type, lat: Number(coord.lat), lon: Number(coord.lon) };
}

// Pastille de ligne aux couleurs Navitia (rond pour le métro)
function navLineBadge(di) {
  const round = /m[ée]tro/i.test(di.commercial_mode || "");
  return (
    `<span class="mini-line${round ? "" : " rect"}" style="background:#${di.color || "1f5fbf"};color:#${di.text_color || "ffffff"}" ` +
    `title="${escapeHtml(`${di.commercial_mode || ""} ${di.code || ""}`.trim())}">${escapeHtml(di.code || di.label || "?")}</span>`
  );
}

// ---------------------------------------------------------------------------
// Saisie des lieux (suggestions Navitia)
// ---------------------------------------------------------------------------
function setupPlaceInput(which) {
  const input = $(`it-${which}`);
  const list = $(`it-${which}-suggest`);
  let timer = null;
  let results = [];

  input.addEventListener("focus", () => {
    it.activeField = which;
    renderQuick();
  });
  input.addEventListener("input", () => {
    it[which] = null;
    clearTimeout(timer);
    timer = setTimeout(search, 250);
  });
  input.addEventListener("blur", () => setTimeout(() => (list.innerHTML = ""), 200));
  input.addEventListener("keydown", (event) => {
    // Entrée : premier résultat proposé
    if (event.key === "Enter" && results.length && !it[which]) {
      event.preventDefault();
      choosePlace(which, results[0]);
    }
  });

  async function search() {
    const q = input.value.trim();
    if (q.length < 2) return (list.innerHTML = "");
    const params = new URLSearchParams({ q, count: "7" });
    ["stop_area", "address", "poi", "administrative_region"].forEach((t) => params.append("type[]", t));
    try {
      const data = await navitia("places", params);
      if (q !== input.value.trim()) return;
      results = (data.places || []).map(placeFromNavitia).filter(Boolean);
      list.innerHTML = results.length
        ? results
            .map((p, i) => {
              const kind = PLACE_KINDS[p.kind] || PLACE_KINDS.coord;
              return (
                `<li><button type="button" data-i="${i}"><span class="it-kind" aria-hidden="true">${kind.icon}</span>` +
                `<span><strong>${escapeHtml(p.name)}</strong><small>${kind.label}</small></span></button></li>`
              );
            })
            .join("")
        : '<li class="hint">Aucun lieu trouvé</li>';
    } catch {
      list.innerHTML = '<li class="hint">Recherche impossible (réseau ?)</li>';
    }
  }

  list.addEventListener("mousedown", (event) => event.preventDefault()); // garde le focus
  list.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-i]");
    if (btn) choosePlace(which, results[btn.dataset.i]);
  });
}

function choosePlace(which, place) {
  it[which] = place;
  $(`it-${which}`).value = place.name;
  $(`it-${which}-suggest`).innerHTML = "";
  it.activeField = which === "from" ? "to" : "from";
  renderQuick();
  if (it.from && it.to) searchJourneys();
  else $(`it-${it.activeField}`).focus();
}

// ---------------------------------------------------------------------------
// Raccourcis : point de départ des réglages, station, favoris, lieux récents
// ---------------------------------------------------------------------------
function quickPlaces() {
  const places = [];
  if (lastOrigin) {
    const isAddress = settings.origin === "address" && settings.address;
    places.push({
      label: isAddress ? "🏠 Mon adresse" : "📍 Ma position",
      place: coordPlace(isAddress ? settings.address.label : "Ma position", lastOrigin.lat, lastOrigin.lon, isAddress ? "address" : "coord"),
    });
  }
  if (station.lat != null) {
    places.push({ label: `🚉 ${station.name}`, place: coordPlace(station.name, station.lat, station.lon, "stop_area") });
  }
  for (const fav of settings.favorites) {
    const s = fav.station;
    if (s.lat == null || places.some((p) => p.place.name === s.name)) continue;
    places.push({ label: `★ ${s.name}`, place: coordPlace(s.name, s.lat, s.lon, "stop_area") });
  }
  for (const p of settings.itRecentPlaces || []) {
    if (places.some((q) => q.place.name === p.name)) continue;
    places.push({ label: `🕘 ${cleanName(p.name)}`, place: p });
  }
  return places.slice(0, 9);
}

function renderQuick() {
  const places = quickPlaces();
  $("it-quick").innerHTML = places.length
    ? `<span class="it-quick-label">${it.activeField === "from" ? "Départ" : "Arrivée"} :</span>` +
      places.map((q, i) => `<button type="button" class="chip" data-i="${i}">${escapeHtml(q.label)}</button>`).join("")
    : "";
  $("it-quick").onclick = (event) => {
    const btn = event.target.closest("button[data-i]");
    if (btn) choosePlace(it.activeField, places[btn.dataset.i].place);
  };
}

// ---------------------------------------------------------------------------
// Recherches récentes
// ---------------------------------------------------------------------------
function rememberSearch() {
  const key = (s) => `${s.from.name}|${s.to.name}`;
  const entry = { from: it.from, to: it.to };
  settings.itRecent = [entry, ...(settings.itRecent || []).filter((s) => key(s) !== key(entry))].slice(0, IT_RECENT_MAX);
  // Lieux récents (pour les raccourcis), hors positions GPS
  const places = [it.to, it.from].filter((p) => p.kind !== "coord");
  settings.itRecentPlaces = [...places, ...(settings.itRecentPlaces || []).filter((p) => !places.some((q) => q.name === p.name))].slice(
    0,
    6
  );
  saveSettings();
  renderRecent();
}

function renderRecent() {
  const recent = settings.itRecent || [];
  $("it-recent").innerHTML = recent.length
    ? `<div class="it-recent-head"><h2>Recherches récentes</h2><button type="button" class="link-small" id="it-recent-clear">Effacer</button></div>` +
      `<ul>${recent
        .map(
          (s, i) =>
            `<li><button type="button" data-i="${i}"><span>${escapeHtml(cleanName(s.from.name))}</span>` +
            `<span class="arrow" aria-hidden="true">→</span><span>${escapeHtml(cleanName(s.to.name))}</span></button></li>`
        )
        .join("")}</ul>`
    : "";
}

$("it-recent").addEventListener("click", (event) => {
  if (event.target.closest("#it-recent-clear")) {
    settings.itRecent = [];
    settings.itRecentPlaces = [];
    saveSettings();
    renderRecent();
    renderQuick();
    return;
  }
  const btn = event.target.closest("button[data-i]");
  if (!btn) return;
  const s = settings.itRecent[btn.dataset.i];
  it.from = s.from;
  it.to = s.to;
  $("it-from").value = s.from.name;
  $("it-to").value = s.to.name;
  setNow();
  searchJourneys();
});

// ---------------------------------------------------------------------------
// Recherche des trajets
// ---------------------------------------------------------------------------
function setNow() {
  $("it-datetime").value = toInputDate(new Date(now()));
  document.querySelector('input[name="it-represents"][value="departure"]').checked = true;
}

function searchOptions() {
  const represents = document.querySelector('input[name="it-represents"]:checked').value;
  const typed = new Date($("it-datetime").value);
  return { represents, datetime: isNaN(typed) ? new Date(now()) : typed };
}

let itRequest = 0;
async function searchJourneys(override = {}) {
  if (!it.from || !it.to) {
    it.error = !it.from ? "Choisissez un départ dans la liste." : "Choisissez une arrivée dans la liste.";
    return renderResults();
  }
  const { represents, datetime } = { ...searchOptions(), ...override };
  const params = new URLSearchParams({
    from: placeRef(it.from),
    to: placeRef(it.to),
    datetime: toNavitiaDate(datetime),
    datetime_represents: represents,
    count: "5",
    min_nb_journeys: "3",
    traveler_type: $("it-pace").value,
    depth: "2",
  });
  // Temps réel quand on cherche « maintenant » (pas en simulation)
  if (!simOffset && Math.abs(datetime - Date.now()) < 3 * 3600000) params.set("data_freshness", "realtime");
  document.querySelectorAll('input[name="it-mode"]').forEach((box) => {
    if (!box.checked) IT_MODE_URIS[box.value].forEach((uri) => params.append("forbidden_uris[]", uri));
  });
  if ($("it-less-walk").checked) params.set("max_walking_duration_to_pt", "600");
  if ($("it-wheelchair").checked) params.set("wheelchair", "true");

  const request = ++itRequest;
  Object.assign(it, { loading: true, error: "", searched: true });
  renderResults();
  busy(1);
  try {
    const data = await navitia("journeys", params);
    if (request !== itRequest) return;
    const all = data.journeys || [];
    // Le trajet « tout à pied » est proposé à part
    it.walkOnly = all.find((j) => (j.tags || []).includes("non_pt") && (j.tags || []).includes("walking")) || null;
    it.journeys = all
      .filter((j) => !(j.tags || []).includes("non_pt"))
      .sort((a, b) => a.departure_date_time.localeCompare(b.departure_date_time));
    it.disruptions = new Map((data.disruptions || []).map((d) => [d.id, d]));
    it.carCo2 = data.context?.car_direct_path?.co2_emission?.value ?? null;
    // Trajet affiché d'office : celui qui arrive le plus tôt
    it.selected = it.journeys.reduce(
      (best, j, i) => (j.arrival_date_time < it.journeys[best].arrival_date_time ? i : best),
      0
    );
    if (!it.journeys.length && !it.walkOnly) it.error = "Aucun trajet trouvé pour cet horaire.";
    rememberSearch();
  } catch (err) {
    if (request !== itRequest) return;
    it.journeys = [];
    it.walkOnly = null;
    it.error =
      err.message === "no_solution"
        ? "Aucun trajet trouvé. Essayez un autre horaire ou d'autres options."
        : `Recherche impossible : ${err.message}`;
  } finally {
    busy(-1);
  }
  if (request !== itRequest) return;
  it.loading = false;
  renderResults();
}

// Perturbations attachées à une section du trajet
function sectionDisruptions(section) {
  return (section.display_informations?.links || [])
    .filter((l) => l.type === "disruption")
    .map((l) => it.disruptions.get(l.id))
    .filter(Boolean);
}
const journeyDisruptions = (j) => {
  const seen = new Map();
  j.sections.forEach((s) => sectionDisruptions(s).forEach((d) => seen.set(d.id, d)));
  return [...seen.values()];
};
// Gravité Navitia -> classes de l'info trafic
const disruptionClass = (d) => {
  const effect = d.severity?.effect || "";
  if (effect === "NO_SERVICE") return "blocking";
  if (/DELAY|REDUCED|DETOUR|MODIFIED|STOP_MOVED/.test(effect)) return "disrupted";
  return "info";
};
const disruptionText = (d) => htmlToText(d.messages?.find((m) => m.channel?.content_type === "text/plain")?.text || d.messages?.[0]?.text || "");

// Étiquettes : le plus rapide, moins de correspondances, moins de marche
function journeyTags(j) {
  const list = it.journeys;
  if (list.length < 2) return [];
  const tags = [];
  const min = (f) => Math.min(...list.map(f));
  const arrival = (x) => navDate(x.arrival_date_time).getTime();
  if (arrival(j) === min(arrival)) tags.push("Arrive le plus tôt");
  if (j.duration === min((x) => x.duration)) tags.push("Le plus rapide");
  if (j.nb_transfers === min((x) => x.nb_transfers) && list.some((x) => x.nb_transfers !== j.nb_transfers)) tags.push("Moins de correspondances");
  const walk = (x) => x.durations?.walking ?? 0;
  if (walk(j) === min(walk) && list.some((x) => walk(x) !== walk(j))) tags.push("Moins de marche");
  return tags;
}

// ---------------------------------------------------------------------------
// Affichage des résultats
// ---------------------------------------------------------------------------
function chainHtml(j) {
  return j.sections
    .map((s) => {
      if (s.type === "public_transport") return navLineBadge(s.display_informations);
      if ((s.type === "street_network" || s.type === "crow_fly") && s.duration >= 60) {
        return `<span class="it-walk">${WALK_ICON}<small>${Math.round(s.duration / 60)}</small></span>`;
      }
      return "";
    })
    .filter(Boolean)
    .join('<span class="it-sep" aria-hidden="true">›</span>');
}

function renderResults() {
  const el = $("it-results");
  if (it.loading) {
    el.innerHTML =
      '<div class="it-list">' +
      '<div class="it-card skeleton"><span></span><span></span><span></span></div>'.repeat(3) +
      "</div>";
    return;
  }
  if (!it.searched || (!it.journeys.length && !it.walkOnly)) {
    el.innerHTML =
      `<div class="it-empty">${
        it.error
          ? `<p class="it-error">${escapeHtml(it.error)}</p>`
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5"/></svg><p>Choisissez un départ et une arrivée pour voir les trajets.</p>'
      }</div>`;
    return;
  }

  const cards = it.journeys
    .map((j, i) => {
      const dep = navDate(j.departure_date_time);
      const arr = navDate(j.arrival_date_time);
      const walkMin = Math.round((j.durations?.walking || 0) / 60);
      const co2 = j.co2_emission?.value;
      const disrupted = journeyDisruptions(j);
      const worst = disrupted.some((d) => disruptionClass(d) === "blocking")
        ? "blocking"
        : disrupted.some((d) => disruptionClass(d) === "disrupted")
          ? "disrupted"
          : disrupted.length
            ? "info"
            : "";
      const meta = [
        j.nb_transfers ? `${j.nb_transfers} correspondance${j.nb_transfers > 1 ? "s" : ""}` : "Direct",
        walkMin ? `${walkMin} min de marche` : "",
        co2 != null ? formatCo2(co2) : "",
      ].filter(Boolean);
      return (
        `<button type="button" class="it-card${i === it.selected ? " selected" : ""}" data-i="${i}">` +
        `<span class="it-times"><strong>${formatTime(dep)} → ${formatTime(arr)}</strong><span class="it-dur">${formatDuration(j.duration)}</span></span>` +
        `<span class="it-chain">${chainHtml(j)}</span>` +
        `<span class="it-meta">${escapeHtml(meta.join(" · "))}</span>` +
        `<span class="it-tags">${journeyTags(j)
          .map((t) => `<span class="tag">${t}</span>`)
          .join("")}${worst ? `<span class="tag sev-${worst}">⚠ Perturbation</span>` : ""}</span>` +
        `</button>`
      );
    })
    .join("");

  const walk = it.walkOnly
    ? `<div class="it-walk-only">${WALK_ICON}<span>Tout à pied : <strong>${formatDuration(it.walkOnly.duration)}</strong>` +
      `${it.walkOnly.distances?.walking ? ` · ${formatMeters(it.walkOnly.distances.walking)}` : ""}</span></div>`
    : "";

  el.innerHTML =
    `<div class="it-list">` +
    `<div class="it-list-head"><h2>${it.journeys.length} trajet${it.journeys.length > 1 ? "s" : ""}</h2>` +
    `<span class="it-nav"><button type="button" class="link-small" id="it-earlier">← Plus tôt</button>` +
    `<button type="button" class="link-small" id="it-later">Plus tard →</button></span></div>` +
    cards +
    walk +
    `</div>` +
    `<div class="it-detail card" id="it-detail">${it.journeys.length ? detailHtml(it.journeys[it.selected]) : ""}</div>`;

  el.querySelectorAll(".it-card").forEach((card) =>
    card.addEventListener("click", () => {
      it.selected = Number(card.dataset.i);
      renderResults();
      if (window.innerWidth < 1000) $("it-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    })
  );
  $("it-earlier")?.addEventListener("click", () => shiftSearch(-1));
  $("it-later")?.addEventListener("click", () => shiftSearch(1));
  $("it-follow")?.addEventListener("click", () => followJourney(it.journeys[it.selected]));
  $("it-share")?.addEventListener("click", () => shareJourney(it.journeys[it.selected]));
  updateItCountdown();
}

// Plus tôt : arriver avant le premier trajet ; plus tard : partir après le dernier
function shiftSearch(direction) {
  if (!it.journeys.length) return;
  const minute = 60000;
  let override;
  if (direction > 0) {
    const last = navDate(it.journeys[it.journeys.length - 1].departure_date_time);
    override = { represents: "departure", datetime: new Date(last.getTime() + minute) };
  } else {
    const first = navDate(it.journeys[0].arrival_date_time);
    override = { represents: "arrival", datetime: new Date(first.getTime() - minute) };
  }
  $("it-datetime").value = toInputDate(override.datetime);
  document.querySelector(`input[name="it-represents"][value="${override.represents}"]`).checked = true;
  searchJourneys(override);
}

// Chronologie détaillée d'un trajet
function detailHtml(j) {
  const dep = navDate(j.departure_date_time);
  const arr = navDate(j.arrival_date_time);
  const steps = [];

  for (const s of j.sections) {
    const t0 = navDate(s.departure_date_time);
    if (s.type === "public_transport") {
      const di = s.display_informations;
      const stops = s.stop_date_times || [];
      const middle = stops.slice(1, -1);
      const realtime = s.data_freshness === "realtime";
      const notes = sectionDisruptions(s)
        .map((d) => `<p class="tl-disruption sev-${disruptionClass(d)}">⚠ ${escapeHtml(disruptionText(d) || d.cause || "Perturbation")}</p>`)
        .join("");
      steps.push(
        `<li class="tl pt" style="--line:#${di.color || "1f5fbf"}">` +
          `<span class="tl-time">${formatTime(t0)}</span>` +
          `<div class="tl-body"><strong>${escapeHtml(cleanName(s.from.name))}</strong>` +
          `<div class="tl-line">${navLineBadge(di)}<span>${escapeHtml(di.commercial_mode || "")} ${escapeHtml(di.code || "")} ` +
          `<b>→ ${escapeHtml(cleanName(di.direction))}</b></span>` +
          `${realtime ? '<span class="rt">● temps réel</span>' : ""}</div>` +
          (middle.length
            ? `<details><summary>${middle.length + 1} arrêt${middle.length ? "s" : ""} · ${formatDuration(s.duration)}</summary><ol>${middle
                .map((st) => `<li><span>${formatTime(navDate(st.departure_date_time))}</span>${escapeHtml(cleanName(st.stop_point.name))}</li>`)
                .join("")}</ol></details>`
            : `<small>${formatDuration(s.duration)}</small>`) +
          notes +
          `</div></li>`,
        `<li class="tl pt-end" style="--line:#${di.color || "1f5fbf"}"><span class="tl-time">${formatTime(navDate(s.arrival_date_time))}</span>` +
          `<div class="tl-body"><strong>${escapeHtml(cleanName(s.to.name))}</strong></div></li>`
      );
    } else if ((s.type === "street_network" || s.type === "crow_fly") && s.duration >= 30) {
      const meters = s.geojson?.properties?.[0]?.length;
      steps.push(
        `<li class="tl walk"><span class="tl-time">${formatTime(t0)}</span><div class="tl-body">` +
          `<span class="tl-walk">${WALK_ICON}Marche ${formatDuration(s.duration)}${meters ? ` · ${formatMeters(meters)}` : ""}</span>` +
          `<small>vers ${escapeHtml(cleanName(s.to.name))}</small></div></li>`
      );
    } else if (s.type === "transfer" && s.duration >= 30) {
      steps.push(
        `<li class="tl walk"><span class="tl-time">${formatTime(t0)}</span><div class="tl-body">` +
          `<span class="tl-walk">${WALK_ICON}Correspondance ${formatDuration(s.duration)}</span></div></li>`
      );
    } else if (s.type === "waiting" && s.duration >= 60) {
      steps.push(
        `<li class="tl wait"><span class="tl-time">${formatTime(t0)}</span><div class="tl-body"><small>Attente ${formatDuration(s.duration)}</small></div></li>`
      );
    }
  }

  // Dernier arrêt = destination : on fusionne au lieu d'afficher deux fois le même nom
  const destination = cleanName(it.to.name);
  const last = steps[steps.length - 1];
  let endStep = `<li class="tl end"><span class="tl-time">${formatTime(arr)}</span><div class="tl-body"><strong>${escapeHtml(destination)}</strong></div></li>`;
  if (last?.includes('class="tl pt-end"') && last.includes(`<strong>${escapeHtml(destination)}</strong>`)) {
    steps.pop();
    endStep = last.replace('class="tl pt-end"', 'class="tl pt-end end"');
  }

  const co2 = j.co2_emission?.value;
  const co2Text =
    co2 != null ? `${formatCo2(co2)}${it.carCo2 ? ` · ${formatCo2(it.carCo2)} en voiture` : ""}` : "";
  return (
    `<div class="it-detail-head">` +
    `<div><p class="muted">${escapeHtml(cleanName(it.from.name))} → ${escapeHtml(cleanName(it.to.name))}</p>` +
    `<h2>${formatTime(dep)} → ${formatTime(arr)} <span class="it-dur">${formatDuration(j.duration)}</span></h2>` +
    `<p class="it-countdown" id="it-countdown" data-dep="${dep.getTime()}"></p></div>` +
    `<div class="it-actions"><button type="button" class="btn" id="it-follow">Suivre sur l'écran Station</button>` +
    `<button type="button" class="link-small" id="it-share">Partager</button></div>` +
    `</div>` +
    `<ol class="timeline"><li class="tl start"><span class="tl-time">${formatTime(dep)}</span><div class="tl-body"><strong>${escapeHtml(
      cleanName(it.from.name)
    )}</strong></div></li>${steps.join("")}${endStep}</ol>` +
    (co2Text ? `<p class="it-co2">🌱 ${escapeHtml(co2Text)}</p>` : "")
  );
}

// « Partez dans 12 min » pour le trajet affiché
function updateItCountdown() {
  const el = $("it-countdown");
  if (!el) return;
  const left = Number(el.dataset.dep) - now();
  if (left < -60000) el.textContent = "Ce trajet est déjà parti";
  else if (left < 60000) el.textContent = "Partez maintenant";
  else if (left < 6 * 3600000) el.textContent = `Partez dans ${formatDuration(left / 1000)}`;
  else el.textContent = "";
  el.classList.toggle("urgent", left >= -60000 && left < 5 * 60000);
}
setInterval(() => {
  if (!$("itineraire").hidden) updateItCountdown();
}, 1000);

// ---------------------------------------------------------------------------
// « Suivre sur l'écran Station » : station de montée + ligne + direction
// ---------------------------------------------------------------------------
async function followJourney(j) {
  const s = j?.sections.find((x) => x.type === "public_transport");
  if (!s) return toast("Ce trajet n'utilise pas les transports en commun");
  const stop = s.from.stop_point || s.from.stop_area || s.from;
  const coord = stop.coord;
  const di = s.display_informations;
  toast(`Réglage de l'écran sur ${cleanName(s.from.name)}…`);
  busy(1);
  try {
    // Arrêts autour du point de montée, regroupés en stations
    const point = `geom'POINT(${coord.lon} ${coord.lat})'`;
    const params = new URLSearchParams({
      select: "zdaid,arrname,arrtown,arrtype,arrgeopoint",
      where: `within_distance(arrgeopoint, ${point}, 250m)`,
      order_by: `distance(arrgeopoint, ${point})`,
      limit: "100",
    });
    const { results = [] } = await (await fetch(`${OPENDATA_URL}/arrets/records?${params}`)).json();
    const stations = groupStations(results);
    const wanted = normalizeName(cleanName(s.from.stop_area?.name || s.from.name));
    const target = stations.find((st) => normalizeName(st.name) === wanted) || stations[0];
    if (!target) throw new Error("station introuvable");

    const lines = await fetchLines(target.zdaids);
    await loadLineColors(lines.map((l) => l.id));
    const code = normalizeName(di.code || "");
    const line = lines.find((l) => normalizeName(l.name) === code) || null;
    const direction = cleanName(di.direction);
    applyStation({
      zdaids: target.zdaids,
      name: target.name,
      town: target.town,
      lat: target.lat,
      lon: target.lon,
      lines,
      line,
      destinations: line && direction ? [direction] : [],
    });
    location.hash = "#station";
    toast(`Écran réglé : ${target.name}${line ? ` · ${MODES[line.mode] || ""} ${line.name}` : ""}${direction ? ` → ${direction}` : ""}`);
  } catch {
    toast("Impossible de régler l'écran sur cette station");
  } finally {
    busy(-1);
  }
}

// Partager / copier un résumé texte du trajet
async function shareJourney(j) {
  const lines = [
    `${cleanName(it.from.name)} → ${cleanName(it.to.name)}`,
    `Départ ${formatTime(navDate(j.departure_date_time))}, arrivée ${formatTime(navDate(j.arrival_date_time))} (${formatDuration(j.duration)})`,
  ];
  for (const s of j.sections) {
    if (s.type === "public_transport") {
      const di = s.display_informations;
      lines.push(
        `• ${di.commercial_mode} ${di.code} → ${cleanName(di.direction)} : ${cleanName(s.from.name)} ${formatTime(
          navDate(s.departure_date_time)
        )} → ${cleanName(s.to.name)} ${formatTime(navDate(s.arrival_date_time))}`
      );
    } else if ((s.type === "street_network" || s.type === "crow_fly") && s.duration >= 60) {
      lines.push(`• Marche ${formatDuration(s.duration)} vers ${cleanName(s.to.name)}`);
    }
  }
  const text = lines.join("\n");
  try {
    if (navigator.share) await navigator.share({ title: "Itinéraire", text });
    else {
      await navigator.clipboard.writeText(text);
      toast("Trajet copié dans le presse-papiers");
    }
  } catch {
    // Partage annulé
  }
}

// ---------------------------------------------------------------------------
// Formulaire
// ---------------------------------------------------------------------------
setupPlaceInput("from");
setupPlaceInput("to");

$("it-form").addEventListener("submit", (event) => {
  event.preventDefault();
  searchJourneys();
});
$("it-swap").addEventListener("click", () => {
  [it.from, it.to] = [it.to, it.from];
  [$("it-from").value, $("it-to").value] = [$("it-to").value, $("it-from").value];
  if (it.from && it.to) searchJourneys();
});
$("it-now").addEventListener("click", () => {
  setNow();
  if (it.from && it.to) searchJourneys();
});
// Changer une option relance la recherche
document.querySelectorAll('#it-form input[type="checkbox"], #it-pace, input[name="it-represents"], #it-datetime').forEach((input) =>
  input.addEventListener("change", () => {
    if (it.from && it.to) searchJourneys();
  })
);

// À l'ouverture : horaire « maintenant » et départ pré-rempli depuis les réglages
window.onItineraryOpen = () => {
  if (!$("it-datetime").value) setNow();
  if (!it.from && lastOrigin) {
    const isAddress = settings.origin === "address" && settings.address;
    it.from = coordPlace(isAddress ? settings.address.label : "Ma position", lastOrigin.lat, lastOrigin.lon, isAddress ? "address" : "coord");
    $("it-from").value = it.from.name;
    it.activeField = "to";
  }
  renderQuick();
  renderRecent();
  if (!it.to) $("it-to").focus();
};

// Ouverture directe sur #itineraire
if (location.hash.startsWith("#itineraire")) window.onItineraryOpen();
