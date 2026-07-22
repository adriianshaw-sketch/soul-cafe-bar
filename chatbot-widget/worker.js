/* ============================================================================
 * chatbot-widget — Proxy seguro (Cloudflare Worker)
 * ----------------------------------------------------------------------------
 * OPCIONAL pero RECOMENDADO para producción. Sirve para que tu API key de
 * Gemini NO viaje en el HTML de la web: en vez de llamar a Google desde el
 * navegador con la key a la vista, el widget llama a ESTE worker, y el worker
 * (que guarda la key en secreto) reenvía la petición a Gemini.
 *
 * Ventajas: la key queda oculta, puedes limitar por dominio (CORS) y el plan
 * gratis de Cloudflare Workers da 100.000 peticiones/día.
 *
 * ─── Cómo desplegarlo (una sola vez, ~5 min) ────────────────────────────────
 * 1. Crea una cuenta gratis en https://dash.cloudflare.com  (Workers & Pages).
 * 2. "Create Worker", pega este archivo entero y despliega. Te dará una URL
 *    tipo  https://mi-chat.TUUSUARIO.workers.dev
 * 3. En el worker: Settings → Variables and Secrets → añade un SECRETO llamado
 *    GEMINI_KEY con tu API key de Gemini.  (Settings → Variables: opcional
 *    ALLOWED_ORIGINS = "https://tudominio.com,https://www.tudominio.com").
 * 4. En tu web, en vez de la key, usa:
 *      <script src="chatbot-widget/loader.js"
 *              data-endpoint="https://mi-chat.TUUSUARIO.workers.dev"></script>
 *    (ya NO hace falta data-gemini-key: la key vive solo en el worker).
 * ==========================================================================*/

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    // Preflight CORS
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }
    if (!env.GEMINI_KEY) {
      return json({ error: 'Falta el secreto GEMINI_KEY en el worker' }, 500, cors);
    }
    // Si definiste ALLOWED_ORIGINS y el origen no está en la lista, RECHAZA aquí:
    // sin esto, un dominio no permitido seguía llegando a Gemini y gastaba tu
    // cuota (relay abierto). El CORS del navegador no basta como control.
    var allowList = (env.ALLOWED_ORIGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (allowList.length && allowList.indexOf(origin) === -1) {
      return json({ error: 'Origin not allowed' }, 403, cors);
    }

    let payload;
    try { payload = await request.json(); }
    catch (e) { return json({ error: 'JSON inválido' }, 400, cors); }

    // El widget manda { model, body }. Validamos el modelo para no dejar el
    // proxy abierto a cualquier cosa.
    const model = String(payload.model || 'gemini-flash-lite-latest');
    if (!/^gemini-[a-z0-9.\-]+$/i.test(model)) {
      return json({ error: 'Modelo no permitido' }, 400, cors);
    }
    const body = payload.body || {};

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent';

    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
        body: JSON.stringify(body)
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return json({ error: 'Fallo al contactar con Gemini' }, 502, cors);
    }
  }
};

function corsHeaders(origin, env) {
  // Si defines ALLOWED_ORIGINS, solo esos dominios podrán usar el proxy.
  const allow = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allow.length === 0 || allow.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allow[0] || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
