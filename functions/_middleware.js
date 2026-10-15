// ---------------------------------------------------------------------------
// Sécurité : ne jamais servir les fichiers locaux contenant la clé PRIM,
// même s'ils ont été envoyés par erreur avec le site.
// ---------------------------------------------------------------------------
const PRIVATE_FILES = /^\/(config\.local\.js|\.dev\.vars)$/i;

export async function onRequest(context) {
  if (PRIVATE_FILES.test(new URL(context.request.url).pathname)) {
    return new Response("Introuvable", { status: 404 });
  }
  return context.next();
}
