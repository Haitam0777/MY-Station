# Ma Station

Tableau de bord temps réel pour les transports d'Île-de-France : prochains passages,
compte à rebours « Partir dans », info trafic, stations proches, trajets favoris et
calculateur d'itinéraire. Données : API PRIM d'Île-de-France Mobilités et open data IDFM.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css` | Page et mise en forme |
| `script.js` | Écran Station, réglages, alertes, info trafic, favoris |
| `itinerary.js` | Page Itinéraire |
| `lines.js` | Outils partagés (tracés, couleurs, appels PRIM) |
| `config.js` | Réglages par défaut (public, **sans clé**) |
| `config.local.js` | Clé PRIM pour tester en local — **ne jamais publier** |
| `functions/api/prim/[[path]].js` | Proxy Cloudflare qui ajoute la clé PRIM côté serveur |
| `functions/_middleware.js`, `_routes.json` | Sécurité : le site publié refuse de servir `config.local.js` |

## Tester en local

Ouvrir `index.html` avec **Live Server** (VS Code). Sur `localhost` / `127.0.0.1` /
réseau local, la page charge `config.local.js` et appelle PRIM directement avec la clé.

Simulation : ajouter `?sim=2026-10-15T18:00` à l'adresse.

## Mettre en ligne (gratuit, sans rien installer)

Le site est publié par **Cloudflare Pages** à partir d'un dépôt **GitHub**.
La clé PRIM est enregistrée comme secret chez Cloudflare : elle n'apparaît jamais
dans la page ni sur GitHub.

### 1. Mettre les fichiers sur GitHub

1. Créer un compte sur <https://github.com> (si besoin).
2. **New repository** → nom : `ma-station` → cocher **Private** → **Create repository**.
3. Cliquer **uploading an existing file**.
4. Glisser **le contenu** du dossier `mon-site` (pas le dossier lui-même),
   **sauf `config.local.js`** :
   - `index.html`, `style.css`, `script.js`, `itinerary.js`, `lines.js`, `config.js`
   - `_routes.json`, `.gitignore`, `README.md`
   - le dossier `functions` (avec `api/prim/[[path]].js` et `_middleware.js`)

   Astuce : les fichiers commençant par un point (`.gitignore`) peuvent être cachés
   dans l'Explorateur Windows ; ce n'est pas grave s'il manque.
5. **Commit changes**.

> ⚠️ Vérifier que `config.local.js` n'est **pas** dans le dépôt. S'il y est par erreur :
> le supprimer sur GitHub, puis demander une nouvelle clé sur PRIM.

### 2. Créer le site sur Cloudflare Pages

1. Créer un compte sur <https://dash.cloudflare.com> (gratuit).
2. **Workers & Pages** → **Create** → onglet **Pages** → **Connect to Git**.
3. Autoriser GitHub et choisir le dépôt `ma-station`.
4. Réglages de build :
   - **Framework preset** : None
   - **Build command** : *(laisser vide)*
   - **Build output directory** : `/`
5. **Save and Deploy**.

### 3. Ajouter la clé PRIM (secret)

1. Dans le projet Pages : **Settings** → **Variables and Secrets** → **Add**.
2. Type **Secret**, nom `PRIM_KEY`, valeur : votre clé PRIM.
3. Enregistrer, puis **Deployments** → sur le dernier déploiement → **Retry deployment**
   (la clé n'est prise en compte qu'après un nouveau déploiement).

Le site est en ligne sur `https://ma-station.pages.dev` (ou le nom choisi).

### 4. Vérifier

- `https://<votre-site>.pages.dev/api/prim/stop-monitoring?MonitoringRef=STIF:StopArea:SP:43230:`
  doit renvoyer du JSON (et non « Clé PRIM manquante »).
- `https://<votre-site>.pages.dev/config.local.js` doit répondre **Introuvable**.
- Sur le téléphone, en HTTPS, le GPS et l'écran toujours allumé fonctionnent.

### Mettre à jour le site

Sur GitHub : **Add file → Upload files**, glisser les fichiers modifiés, **Commit**.
Cloudflare republie automatiquement en une minute.

## Bon à savoir

- Le proxy n'accepte que les API utilisées par le site (prochains passages, info trafic,
  itinéraires) et met les réponses en cache quelques secondes à quelques minutes pour
  économiser le quota PRIM quand plusieurs personnes utilisent le site.
- Offre gratuite Cloudflare : 100 000 appels au proxy par jour, largement suffisant
  pour un usage personnel ou familial.
- Domaine personnalisé : projet Pages → **Custom domains**.
