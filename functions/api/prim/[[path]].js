// ---------------------------------------------------------------------------
// Proxy PRIM (Cloudflare Pages Function)
// GET /api/prim/<chemin>?<paramètres>  ->  https://prim.iledefrance-mobilites.fr/marketplace/<chemin>
// La clé API reste secrète côté serveur : variable d'environnement PRIM_KEY
// (Cloudflare > Pages > projet > Settings > Variables and Secrets).
// ---------------------------------------------------------------------------
const PRIM_URL = "https://prim.iledefrance-mobilites.fr/marketplace/";

// Seules les API utilisées par le site passent (le proxy n'est pas ouvert à tout PRIM)
const ALLOWED = [
  /^stop-monitoring$/, // prochains passages
  /^disruptions_bulk\/disruptions\/v2$/, // info trafic
  /^v2\/navitia\/(places|journeys)$/, // itinéraires
];

// Mise en cache côté Cloudflare (secondes) : économise le quota PRIM quand
// plusieurs personnes utilisent le site en même temps
const CACHE_SECONDS = {
  "stop-monitoring": 20,
  "disruptions_bulk/disruptions/v2": 120,
  "v2/navitia/places": 3600,
  "v2/navitia/journeys": 30,
};

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const path = (params.path || []).join("/");
  if (!ALLOWED.some((rule) => rule.test(path))) return json(404, { error: "Chemin non autorisé" });
  if (!env.PRIM_KEY) return json(500, { error: "Clé PRIM manquante : ajoutez la variable PRIM_KEY dans Cloudflare" });

  const target = `${PRIM_URL}${path}${new URL(request.url).search}`;
  const ttl = CACHE_SECONDS[path] || 0;
  const language = request.headers.get("Accept-Language")?.startsWith("en") ? "en" : "fr";
  // La clé de cache ne contient jamais la clé API
  const cacheKey = new Request(`${target}${target.includes("?") ? "&" : "?"}_lang=${language}`);
  const cache = caches.default;

  if (ttl) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { apikey: env.PRIM_KEY, Accept: "application/json", "Accept-Language": language },
    });
  } catch {
    return json(502, { error: "PRIM injoignable" });
  }

  const response = new Response(upstream.body, upstream);
  response.headers.delete("Set-Cookie");
  response.headers.set("Cache-Control", ttl ? `public, max-age=${ttl}` : "no-store");
  if (ttl && upstream.ok) context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
