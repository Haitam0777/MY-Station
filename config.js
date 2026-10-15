// Configuration du site
const CONFIG = {
  // API PRIM (Île-de-France Mobilités) : https://prim.iledefrance-mobilites.fr
  // Site publié : les appels passent par le proxy /api/prim, la clé est un secret
  // Cloudflare (PRIM_KEY). Ne jamais mettre la clé ici : ce fichier est public.
  // Pour tester en local avec Live Server, la clé va dans config.local.js.
  primApiKey: "",
  primProxy: "/api/prim",

  // Station par défaut (modifiable à l'écran en touchant son nom)
  // zdaid : zone d'arrêt du jeu de données « arrets » ; line : null = toutes les lignes
  station: {
    zdaid: "43230",
    name: "Les Grésillons",
    town: "Gennevilliers",
    lat: 48.921,
    lon: 2.3138,
    line: { id: "C01727", name: "C", mode: "RapidTransit" },
  },

  // Valeurs par défaut, modifiables dans la page « Réglages » :
  // point de départ = position GPS (true) ou adresse (false)
  useGps: true,
  // Marge de sécurité ajoutée au temps de marche (entrée en gare, quai, imprévus)
  marginMinutes: 0,
  // Temps de marche utilisé si le GPS est indisponible ou sans adresse (minutes)
  walkMinutes: 5,

  // Garder seulement les trains vers ces destinations (vide = toutes)
  // ex : ["Paris", "Versailles"]
  destinations: [],

  // Rafraîchissement (ms)
  refreshMs: 30000,
  weatherRefreshMs: 15 * 60 * 1000,
};
