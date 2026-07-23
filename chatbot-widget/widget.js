/* ============================================================================
 * Chatbot Widget — widget.js
 * ----------------------------------------------------------------------------
 * Widget de atención al cliente que se estudia SOLO el contenido de la web
 * donde vive y responde preguntas reales. Cero configuración por proyecto:
 * se integra con una línea y lo lee todo por sí mismo.
 *
 *  FASE 1 (una vez, cacheada en sessionStorage):
 *    extraer texto visible + JSON-LD  ->  Gemini estructura los datos del
 *    negocio (nombre, teléfono, dirección, horario por día).
 *  Con ese horario, JavaScript PURO (nunca la IA) calcula si está abierto AHORA.
 *
 *  FASE 2 (cada mensaje):
 *    Gemini recibe los datos ya resueltos (incluido abierto/cerrado) + el
 *    contenido de la página + el historial, y SOLO redacta la respuesta.
 *
 * Vanilla JS, sin frameworks, sin backend. La llamada a Gemini va directa
 * desde el navegador con la key que llega en data-gemini-key (ver README).
 * ==========================================================================*/
(function () {
  'use strict';

  if (window.__cbwLoaded) return;      // no duplicar si se inyecta dos veces
  window.__cbwLoaded = true;

  /* =========================================================================
   * CONFIGURACIÓN
   * =======================================================================*/
  var CFG = window.CBW_CONFIG || {};

  // --- Modelos de Gemini (con fallback en cadena) --------------------------
  // Se prueban EN ORDEN. Si el primero da 429 (cuota agotada) o 404 (modelo
  // retirado), salta al siguiente — que tiene su PROPIA cuota. Así el widget
  // aguanta a la vez el churn de modelos de Google y los topes del plan gratis.
  // Por qué Flash-Lite primero: su cuota GRATIS es enorme frente al flash tope
  // de gama (gemini-3.5-flash free = solo 20 peticiones/día, se agota en una
  // tarde y el bot deja de responder; flash-lite ≈ 1.000-1.500/día). Para leer
  // la web y responder, Lite sobra. data-gemini-model fuerza uno concreto.
  var MODELS = (CFG.model ? [CFG.model] : [])
    .concat(['gemini-flash-lite-latest', 'gemini-flash-latest']);
  MODELS = MODELS.filter(function (m, i) { return m && MODELS.indexOf(m) === i; });

  function endpointFor(model) {
    return 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent';
  }

  // Proxy opcional (data-endpoint): si se define, el widget NO manda la key al
  // navegador; hace POST {model, body} a tu proxy (p.ej. un Cloudflare Worker,
  // ver worker.js + README) y es este quien guarda la key. Es la forma SEGURA.
  var PROXY = CFG.endpoint || '';

  var API_KEY = CFG.key || '';
  var ACCENT = CFG.accent || '';        // opcional: color de acento por marca
  // opcional: data-font="inherit" para adoptar la tipografía de la web host
  // (o una familia concreta). Por defecto Inter: chrome neutro de UI que no
  // compite con la tipografía de marca del cliente.
  var FONT = CFG.font || '';
  var NAME_OVERRIDE = CFG.name || '';   // opcional: forzar nombre del negocio
  var PHONE_OVERRIDE = CFG.phone || ''; // opcional: forzar teléfono de contacto
  var REQUEST_TIMEOUT = 15000;          // 15s por llamada (AbortController)

  // Sentinela de "no lo sé": el modelo lo emite cuando no tiene el dato.
  // Es MUCHO más robusto que casar una frase exacta en español, y funciona
  // en cualquier idioma. El widget lo detecta, lo quita y muestra el fallback.
  var NO_INFO = '[[NO_INFO]]';

  // Claves de almacenamiento (sessionStorage se reinicia en cada visita).
  var SS_BUSINESS = 'cbw:business';   // datos estructurados de la Fase 1
  var SS_PAGES    = 'cbw:pages';      // { "/ruta": "texto extraído", ... }
  var SS_HISTORY  = 'cbw:history';    // [{ role:'user'|'model', text }]
  var LS_SEEN     = 'cbw_seen';       // ¿el usuario ha visto el widget alguna vez?

  var DIAS = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado']; // índice = Date.getDay()
  var DIAS_ORD = ['lunes','martes','miercoles','jueves','viernes','sabado','domingo']; // orden natural de lectura

  /* =========================================================================
   * i18n del "chrome" del widget (los textos fijos de la interfaz).
   * Las RESPUESTAS del bot son multiidioma vía Gemini; esto es solo la UI.
   * =======================================================================*/
  var LOCALE = detectLocale();
  var I18N = {
    es: { placeholder:'Escribe tu pregunta…', online:'En línea', open:'Abierto', closed:'Cerrado',
          send:'Enviar', close:'Cerrar', ask:'Pregúntanos', you:'Tú',
          dialog:'Asistente de atención al cliente',
          noInfo:'No tengo ese dato exacto en la web, pero el negocio puede ayudarte directamente:',
          wa:'Escribir por WhatsApp', call:'Llamar',
          apiError:'Ahora mismo no puedo responder. Inténtalo de nuevo o escríbenos por WhatsApp.',
          apiBusy:'Estamos recibiendo muchas consultas ahora mismo. Prueba en un momento o escríbenos por WhatsApp.',
          greet:'Hola, soy el asistente de {name}. Cuéntame qué necesitas saber.',
          waIntro:'Hola, vengo de la página web y tengo una duda: ',
          credit:'Asistente con IA',
          sugg:['¿Qué ofrecéis?','¿Estáis abiertos ahora?','¿Dónde estáis?'] },
    en: { placeholder:'Type your question…', online:'Online', open:'Open', closed:'Closed',
          send:'Send', close:'Close', ask:'Ask us', you:'You',
          dialog:'Customer support assistant',
          noInfo:"I don't have that exact detail on the site, but the business can help you directly:",
          wa:'Message on WhatsApp', call:'Call',
          apiError:"I can't reply right now. Please try again or message us on WhatsApp.",
          apiBusy:"We're getting a lot of questions right now. Try again in a moment or message us on WhatsApp.",
          greet:'Hi, I\'m {name}\'s assistant. Tell me what you\'d like to know.',
          waIntro:'Hi, I\'m coming from your website and I have a question: ',
          credit:'AI assistant',
          sugg:['What do you offer?','Are you open now?','Where are you?'] },
    fr: { placeholder:'Écrivez votre question…', online:'En ligne', open:'Ouvert', closed:'Fermé',
          send:'Envoyer', close:'Fermer', ask:'Une question ?', you:'Vous',
          dialog:'Assistant du service client',
          noInfo:"Je n'ai pas cette information exacte sur le site, mais l'entreprise peut vous aider directement :",
          wa:'Écrire sur WhatsApp', call:'Appeler',
          apiError:"Je ne peux pas répondre pour le moment. Réessayez ou écrivez-nous sur WhatsApp.",
          apiBusy:"Nous recevons beaucoup de questions en ce moment. Réessayez dans un instant ou écrivez-nous sur WhatsApp.",
          greet:'Bonjour, je suis l\'assistant de {name}. Dites-moi ce que vous cherchez.',
          waIntro:'Bonjour, je viens de votre site web et j\'ai une question : ',
          credit:'Assistant IA',
          sugg:['Que proposez-vous ?','Êtes-vous ouverts ?','Où êtes-vous ?'] },
    de: { placeholder:'Ihre Frage…', online:'Online', open:'Geöffnet', closed:'Geschlossen',
          send:'Senden', close:'Schließen', ask:'Frag uns', you:'Du',
          dialog:'Kundenservice-Assistent',
          noInfo:'Diese genaue Angabe steht nicht auf der Seite, aber das Unternehmen hilft dir direkt weiter:',
          wa:'Auf WhatsApp schreiben', call:'Anrufen',
          apiError:'Ich kann gerade nicht antworten. Bitte erneut versuchen oder per WhatsApp schreiben.',
          apiBusy:'Wir erhalten gerade sehr viele Anfragen. Versuchen Sie es gleich erneut oder schreiben Sie uns per WhatsApp.',
          greet:'Hallo, ich bin der Assistent von {name}. Sag mir, was du wissen möchtest.',
          waIntro:'Hallo, ich komme von Ihrer Website und habe eine Frage: ',
          credit:'KI-Assistent',
          sugg:['Was bieten Sie an?','Haben Sie geöffnet?','Wo befinden Sie sich?'] },
    it: { placeholder:'Scrivi la tua domanda…', online:'Online', open:'Aperto', closed:'Chiuso',
          send:'Invia', close:'Chiudi', ask:'Chiedici', you:'Tu',
          dialog:'Assistente clienti',
          noInfo:'Non ho questo dato preciso sul sito, ma l\'attività può aiutarti direttamente:',
          wa:'Scrivi su WhatsApp', call:'Chiama',
          apiError:'Non posso rispondere ora. Riprova o scrivici su WhatsApp.',
          apiBusy:'Stiamo ricevendo molte richieste in questo momento. Riprova tra poco o scrivici su WhatsApp.',
          greet:'Ciao, sono l\'assistente di {name}. Dimmi di cosa hai bisogno.',
          waIntro:'Ciao, vengo dal vostro sito web e ho una domanda: ',
          credit:'Assistente IA',
          sugg:['Cosa offrite?','Siete aperti ora?','Dove siete?'] },
    pt: { placeholder:'Escreve a tua pergunta…', online:'Online', open:'Aberto', closed:'Fechado',
          send:'Enviar', close:'Fechar', ask:'Pergunta-nos', you:'Tu',
          dialog:'Assistente de apoio ao cliente',
          noInfo:'Não tenho esse dado exato no site, mas o negócio pode ajudar-te diretamente:',
          wa:'Escrever no WhatsApp', call:'Ligar',
          apiError:'Não consigo responder agora. Tenta de novo ou escreve-nos no WhatsApp.',
          apiBusy:'Estamos a receber muitas perguntas agora. Tenta daqui a pouco ou escreve-nos no WhatsApp.',
          greet:'Olá, sou o assistente de {name}. Diz-me o que precisas de saber.',
          waIntro:'Olá, venho do vosso site e tenho uma dúvida: ',
          credit:'Assistente com IA',
          sugg:['O que oferecem?','Estão abertos agora?','Onde estão?'] }
  };
  var T = I18N[LOCALE] || I18N.es;

  /* =========================================================================
   * UTILIDADES DE ALMACENAMIENTO (a prueba de modo incógnito / cuota llena)
   * =======================================================================*/
  function ssGet(key, fallback) {
    try { var v = sessionStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function ssSet(key, val) {
    try { sessionStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }

  function detectLocale() {
    var lang = (document.documentElement.getAttribute('lang') ||
                navigator.language || 'es').toLowerCase().slice(0, 2);
    return ['es','en','fr','de','it','pt'].indexOf(lang) >= 0 ? lang : 'es';
  }

  /* =========================================================================
   * EXTRACCIÓN DE CONTENIDO DE LA PÁGINA
   * =======================================================================*/
  // Texto visible, ignorando nav/footer/scripts y NUESTRO propio widget.
  function extractPageContent() {
    // Nota: NO saltamos <footer>: negocios locales ponen ahí horario/dirección
    // muy a menudo. Sí saltamos nav/scripts/etc.
    var skip = ['script','style','nav','noscript','iframe','svg','template'];
    if (!document.body) return '';
    var walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      { acceptNode: function (node) {
          var p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          // Nunca ingerir el propio chat (si no, se leería a sí mismo).
          if (p.closest('#cbw-root')) return NodeFilter.FILTER_REJECT;
          if (skip.some(function (t) { return p.closest(t); }))
            return NodeFilter.FILTER_REJECT;
          // Ignora nodos ocultos (display:none / visibility:hidden).
          if (p.offsetParent === null && p.tagName !== 'BODY') {
            var cs = getComputedStyle(p);
            if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          }
          return node.textContent.trim().length > 2
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }}
    );
    var text = '';
    while (walker.nextNode()) text += walker.currentNode.textContent.trim() + ' ';
    return text.replace(/\s+/g, ' ').trim().slice(0, 8000);
  }

  // Datos estructurados schema.org, muy comunes en webs con buen SEO.
  function extractJsonLd() {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      try {
        var data = JSON.parse(scripts[i].textContent);
        var items = Array.isArray(data) ? data : (data['@graph'] || [data]);
        for (var j = 0; j < items.length; j++) {
          var t = items[j] && items[j]['@type'];
          t = Array.isArray(t) ? t.join(' ') : (t || '');
          if (/LocalBusiness|Restaurant|Store|Organization|Hotel|CafeOrCoffeeShop|BarOrPub|FoodEstablishment/i.test(t))
            return items[j];
        }
      } catch (e) {}
    }
    return null;
  }

  // Teléfono: primero enlaces reales del DOM (tel: y wa.me — fuente fiable),
  // luego regex española sobre el texto.
  function extractPhone(pageText) {
    if (PHONE_OVERRIDE) return PHONE_OVERRIDE;
    var tel = document.querySelector('a[href^="tel:"]');
    if (tel) return tel.getAttribute('href').replace('tel:', '').trim();
    var wa = document.querySelector('a[href*="wa.me/"], a[href*="api.whatsapp.com"], a[href*="web.whatsapp.com"]');
    if (wa) {
      var m = wa.getAttribute('href').match(/(?:wa\.me\/|phone=)(\+?\d{6,15})/);
      if (m) return m[1];
    }
    var re = /(?:\+34|0034)?[\s.\-]?[6789]\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3}/;
    var hit = (pageText || '').match(re);
    return hit ? hit[0].trim() : '';
  }

  // Acumula el texto de cada página visitada dentro del mismo sitio.
  function updatePagesStore() {
    var pages = ssGet(SS_PAGES, {});
    pages[location.pathname] = extractPageContent();
    ssSet(SS_PAGES, pages);
    return pages;
  }
  function allPagesText() {
    var pages = ssGet(SS_PAGES, {});
    var out = [];
    for (var k in pages) if (pages[k]) out.push(pages[k]);
    return out.join('\n\n').slice(0, 12000); // tope global de contexto
  }

  /* =========================================================================
   * LLAMADA A GEMINI (con timeout y manejo de errores)
   * =======================================================================*/
  function extractText(data) {
    var parts = data && data.candidates && data.candidates[0] &&
                data.candidates[0].content && data.candidates[0].content.parts;
    var text = '';
    if (parts) for (var i = 0; i < parts.length; i++) text += (parts[i].text || '');
    return text.trim();
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Clasifica el fallo para poder actuar distinto según la causa.
  //  auth    -> la KEY no vale / está restringida (401/403, o 400 de api key)
  //  quota   -> cuota agotada (429)  -> probar otro modelo
  //  model   -> modelo retirado (404) -> probar otro modelo
  //  network -> caída/timeout/CORS
  function classifyError(status, bodyText) {
    var b = (bodyText || '').toLowerCase();
    if (status === 401 || status === 403) return 'auth';
    if (status === 400 && (b.indexOf('api key') >= 0 || b.indexOf('api_key') >= 0 ||
        b.indexOf('permission') >= 0 || b.indexOf('unregistered') >= 0)) return 'auth';
    if (status === 429) return 'quota';
    if (status === 404) return 'model';
    return 'other';
  }

  // Punto de entrada: intenta los modelos de la lista en orden. Un 429/404 en
  // uno hace saltar al siguiente (cuota independiente / resistencia al churn).
  function callGemini(body) { return tryModels(body, 0, {}); }

  function tryModels(body, idx, memo) {
    return doGemini(body, MODELS[idx], {}).catch(function (err) {
      var canFallback = (err.kind === 'quota' || err.kind === 'model') && idx + 1 < MODELS.length;
      if (canFallback) {
        if (window.console) console.info('[cbw] "' + MODELS[idx] + '" (' + err.kind +
          '); probando "' + MODELS[idx + 1] + '"');
        return tryModels(body, idx + 1, memo);
      }
      throw err;
    });
  }

  // Una llamada concreta a un modelo. Reintentos defensivos (una vez cada uno):
  //  · 400 que menciona "thinking" -> quita thinkingConfig y reintenta.
  //  · 429/503 puntual -> espera corta y reintenta el MISMO modelo una vez.
  function doGemini(body, model, retried) {
    var url = PROXY || endpointFor(model);
    var headers = { 'Content-Type': 'application/json' };
    var payload;
    if (PROXY) {
      // Modo seguro: la key la pone el proxy; aquí solo va modelo + cuerpo.
      payload = JSON.stringify({ model: model, body: body });
    } else {
      headers['x-goog-api-key'] = API_KEY; // en cabecera, nunca en la URL
      payload = JSON.stringify(body);
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT);
    var done = function () { clearTimeout(timer); };
    return fetch(url, { method: 'POST', headers: headers, body: payload, signal: ctrl.signal })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            // 400 con thinkingConfig presente -> quítalo y reintenta. (Los modelos
            // Lite lo rechazan con un 400 genérico que NO menciona "thinking", así
            // que NO condicionamos al texto: si está el campo y hay 400, se prueba
            // sin él una vez. Si el 400 era por otra causa, volverá a fallar y se
            // clasifica bien.)
            if (!retried.noThink && res.status === 400 &&
                body.generationConfig && body.generationConfig.thinkingConfig) {
              done(); retried.noThink = true;
              var b2 = JSON.parse(JSON.stringify(body));
              delete b2.generationConfig.thinkingConfig;
              return doGemini(b2, model, retried);
            }
            if (!retried.rate && (res.status === 429 || res.status === 503)) {
              done(); retried.rate = true;
              return wait(1200).then(function () { return doGemini(body, model, retried); });
            }
            done();
            var e = new Error('Gemini ' + res.status + ': ' + t.slice(0, 180));
            e.status = res.status;
            e.kind = classifyError(res.status, t);
            throw e;
          });
        }
        return res.json().then(function (data) { done(); return extractText(data); });
      }, function (err) {
        done();
        if (!err.kind) err.kind = 'network'; // abort/timeout/CORS/caída
        throw err;
      });
  }

  /* =========================================================================
   * FASE 1 — Estructurar los datos del negocio (cacheado en sessionStorage)
   * =======================================================================*/
  var BUSINESS_SCHEMA = {
    type: 'object',
    properties: {
      nombreNegocio: { type: 'string' },
      telefono: { type: 'string', description: 'Solo dígitos, con prefijo de país si aparece' },
      direccion: { type: 'string' },
      horario: {
        type: 'object',
        description: 'Cada día es un array de tramos {apertura,cierre} en HH:MM 24h. Array vacío si cierra ese día.',
        properties: dayObject(),
        // Forzamos las 7 claves: sin esto el modelo agrupa/omite días (p.ej.
        // "martes a jueves") y luego un jueves el widget lo daría por cerrado.
        required: DIAS_ORD,
        propertyOrdering: DIAS_ORD
      },
      resumenServicios: { type: 'string' }
    },
    required: ['nombreNegocio']
  };
  function dayObject() {
    var slot = { type:'array', items:{ type:'object',
      properties:{ apertura:{type:'string'}, cierre:{type:'string'} },
      required:['apertura','cierre'] } };
    var o = {};
    DIAS_ORD.forEach(function (d) { o[d] = slot; });
    return o;
  }

  function buildBusinessData() {
    var cached = ssGet(SS_BUSINESS, null);
    if (cached) return Promise.resolve(cached);
    if (!API_KEY && !PROXY) return Promise.resolve(fallbackBusiness());

    var pageText = allPagesText();
    var jsonld = extractJsonLd();
    var prompt =
      'Extrae los datos del negocio a partir del contenido de esta página web y, si existe, ' +
      'sus datos estructurados JSON-LD. Devuelve SOLO el JSON del esquema. Para el horario, ' +
      'interpreta cualquier forma de escribirlo en lenguaje natural (español u otros) y ' +
      'normalízalo a tramos HH:MM en 24h por día. INCLUYE SIEMPRE las 7 claves de día ' +
      '(lunes, martes, miercoles, jueves, viernes, sabado, domingo) por separado: si un ' +
      'rango aplica a varios días (p.ej. "de martes a jueves"), repítelo en CADA día; nunca ' +
      'agrupes ni omitas un día. Array vacío solo si ese día cierra. Si un dato no aparece, ' +
      'déjalo vacío; nunca inventes.\n\n' +
      (jsonld ? 'JSON-LD:\n' + JSON.stringify(jsonld).slice(0, 3000) + '\n\n' : '') +
      'CONTENIDO:\n' + pageText.slice(0, 8000);

    return callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: BUSINESS_SCHEMA,
        temperature: 0
      }
    }).then(function (txt) {
      var parsed;
      try { parsed = JSON.parse(txt); } catch (e) { parsed = fallbackBusiness(); }
      // Rellena huecos con lo que sepamos por otros medios.
      if (!parsed.nombreNegocio) parsed.nombreNegocio = detectBusinessName();
      if (!parsed.telefono) parsed.telefono = extractPhone(pageText);
      if (NAME_OVERRIDE) parsed.nombreNegocio = NAME_OVERRIDE;
      if (PHONE_OVERRIDE) parsed.telefono = PHONE_OVERRIDE;
      ssSet(SS_BUSINESS, parsed);
      return parsed;
    }).catch(function () {
      var fb = fallbackBusiness();
      // No lo cacheamos en error: así se reintenta en el próximo arranque.
      return fb;
    });
  }

  function fallbackBusiness() {
    return {
      nombreNegocio: NAME_OVERRIDE || detectBusinessName(),
      telefono: extractPhone(allPagesText()),
      direccion: '',
      horario: null,
      resumenServicios: ''
    };
  }

  function detectBusinessName() {
    if (NAME_OVERRIDE) return NAME_OVERRIDE;
    // 1) og:site_name: es literalmente el nombre del sitio, lo más fiable.
    var og = document.querySelector('meta[property="og:site_name"]');
    if (og && og.content && og.content.trim()) return og.content.trim().slice(0, 60);
    // 2) Primer segmento del <title> ("Negocio — Tagline" -> "Negocio").
    var title = (document.title || '').split(/[|–—\-·:]/)[0].trim();
    if (title.length >= 2 && title.length <= 40) return title;
    // 3) H1 como último recurso (a menudo es un titular de marketing, no el nombre).
    var h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim()) return h1.textContent.trim().slice(0, 60);
    return title || 'este negocio';
  }

  /* =========================================================================
   * ABIERTO / CERRADO — SIEMPRE en JavaScript, NUNCA la IA
   *   Maneja tramos partidos y horarios que cruzan medianoche (bares, p.ej.
   *   20:00–02:00), incluido el tramo de ayer que sigue vivo pasada la 01:00.
   * =======================================================================*/
  function parseHM(s) {
    var p = String(s).split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }

  function getOpenStatus(horario) {
    if (!horario) return null;
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var todayIdx = now.getDay();

    // Tramos de HOY (incluyendo los que cruzan medianoche).
    var today = horario[DIAS[todayIdx]] || [];
    for (var i = 0; i < today.length; i++) {
      var o = parseHM(today[i].apertura), c = parseHM(today[i].cierre);
      if (c <= o) c += 1440; // cierra de madrugada
      if (nowMin >= o && nowMin < c) return { abierto: true, cierraA: today[i].cierre };
    }
    // Tramo de AYER que sigue abierto pasada la medianoche (ej. 20:00–02:00).
    var yest = horario[DIAS[(todayIdx + 6) % 7]] || [];
    for (var k = 0; k < yest.length; k++) {
      var yo = parseHM(yest[k].apertura), yc = parseHM(yest[k].cierre);
      if (yc <= yo && nowMin < yc) return { abierto: true, cierraA: yest[k].cierre };
    }
    return { abierto: false };
  }

  // Próxima apertura recorriendo hasta 7 días, para decir "abre mañana a las 09:00".
  function getNextOpening(horario) {
    if (!horario) return null;
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var todayIdx = now.getDay();
    for (var d = 0; d < 7; d++) {
      var idx = (todayIdx + d) % 7;
      var slots = (horario[DIAS[idx]] || []).slice().sort(function (a, b) {
        return parseHM(a.apertura) - parseHM(b.apertura);
      });
      for (var s = 0; s < slots.length; s++) {
        var o = parseHM(slots[s].apertura);
        if (d === 0 && o <= nowMin) continue; // ya ha pasado hoy
        return { dia: DIAS[idx], diaOffset: d, apertura: slots[s].apertura };
      }
    }
    return null;
  }

  // Frase en español (referencia para el prompt; Gemini la traducirá si hace falta).
  function statusSentence(horario) {
    var st = getOpenStatus(horario);
    if (!st) return null; // no hay horario conocido
    if (st.abierto) return { abierto: true, texto: 'ABIERTO ahora, cierra a las ' + st.cierraA };
    var nx = getNextOpening(horario);
    if (!nx) return { abierto: false, texto: 'CERRADO ahora' };
    var cuando = nx.diaOffset === 0 ? 'hoy'
               : nx.diaOffset === 1 ? 'mañana'
               : 'el ' + nx.dia;
    return { abierto: false, texto: 'CERRADO ahora; próxima apertura ' + cuando + ' a las ' + nx.apertura };
  }

  /* =========================================================================
   * FASE 2 — Responder una pregunta del usuario
   * =======================================================================*/
  function buildSystemPrompt(biz) {
    var now = new Date();
    var fecha = now.toLocaleDateString('es-ES', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
    var hora = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    var st = statusSentence(biz.horario);
    var estado = st ? st.texto : 'horario no publicado en la web';

    return [
      'Eres parte del equipo de "' + (biz.nombreNegocio || 'este negocio') + '" y atiendes a',
      'sus clientes por el chat de la web. Hablas como una persona real del negocio: cercano,',
      'natural y con calidez, en primera persona del plural ("tenemos", "estamos"). NADA de',
      'fórmulas robóticas tipo "Como asistente virtual..."; ve directo a ayudar.',
      '',
      'DATOS VERIFICADOS (son reales y ya calculados; NO los cuestiones ni los recalcules):',
      '- Fecha y hora actuales: ' + fecha + ', ' + hora + ' (hora local del cliente).',
      '- Estado ahora mismo: ' + estado + '.',
      '- Teléfono: ' + (biz.telefono || 'no disponible') + '.',
      '- Dirección: ' + (biz.direccion || 'no disponible') + '.',
      (biz.resumenServicios ? '- Servicios (resumen): ' + biz.resumenServicios + '.' : ''),
      '',
      'CONTENIDO DE LA PÁGINA (tu fuente principal para servicios, precios,',
      'productos, cartas, ingredientes, tallas, ubicación, políticas, etc.):',
      '"""',
      allPagesText(),
      '"""',
      '',
      'CÓMO RESPONDER:',
      '1. Fuente principal = el contenido de la página y los datos verificados de arriba.',
      '   Úsalos siempre que respondan a la pregunta.',
      '2. SÉ ÚTIL, no un muro de "no lo sé". Si la pregunta es sobre el SECTOR del negocio',
      '   (p.ej. en placas solares: "¿puedo instalar en tejado plano?", "¿cuántas placas',
      '   para una nevera?"; en un restaurante: alérgenos habituales de un plato; en ropa:',
      '   cómo suele tallar una prenda), puedes dar una orientación general y sensata,',
      '   dejando SIEMPRE claro que es aproximada e invitando a confirmarlo con el negocio',
      '   (presupuesto/estudio/reserva). Marca las estimaciones como aproximadas.',
      '3. NUNCA inventes datos ESPECÍFICOS del negocio que no aparezcan: precios exactos,',
      '   medidas/potencias concretas, disponibilidad, teléfonos o direcciones distintas.',
      '   Para esos, remite al negocio.',
      '4. Solo si NO puedes ayudar de forma útil (te piden un dato concreto que el negocio',
      '   no ha publicado y no cabe orientación general): escribe una frase breve y amable',
      '   invitando a contactar, y TERMINA con el token literal ' + NO_INFO + ' en su propia',
      '   línea. No uses ese token si has podido ayudar aunque sea de forma general.',
      '5. Responde SIEMPRE en el idioma del usuario y ULTRA BREVE: idealmente 1 frase,',
      '   2 como máximo absoluto, y nunca más de ~35 palabras. Ve directo al dato.',
      '   Prohibido: repetir la pregunta, saludos, introducciones ("Gracias por tu',
      '   pregunta", "Claro que sí"), coletillas y cierres de relleno. Si cabe en una',
      '   frase, una frase. Calidez sí, paja no.',
      '6. Para horario/"¿está abierto?", usa el "Estado ahora mismo" de arriba tal cual,',
      '   sin recalcular fechas por tu cuenta.',
      '7. Temas totalmente ajenos al negocio (política, deberes, recetas de otra cosa):',
      '   declina con amabilidad y recuerda que ayudas con temas de esta web.'
    ].filter(Boolean).join('\n');
  }

  function answerQuestion(biz, userText) {
    // El historial YA termina con el mensaje actual (onSend lo guardó antes de
    // llamar aquí), así que NO lo volvemos a añadir (antes se duplicaba).
    var raw = ssGet(SS_HISTORY, []).slice(-12);
    // Colapsa turnos consecutivos del mismo rol: tras un envío fallido quedan
    // dos 'user' seguidos y Gemini exige alternancia user/model (si no, 400).
    var contents = [];
    raw.forEach(function (m) {
      var last = contents[contents.length - 1];
      if (last && last.role === m.role) last.parts[0].text += '\n' + m.text;
      else contents.push({ role: m.role, parts: [{ text: m.text }] });
    });
    while (contents.length && contents[0].role === 'model') contents.shift();

    return callGemini({
      systemInstruction: { parts: [{ text: buildSystemPrompt(biz) }] },
      contents: contents,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 120        // respuestas ULTRA cortas (1-2 frases) + ahorro de tokens
        // Sin thinkingConfig: el modelo por defecto (flash-lite) NO lo soporta y ya
        // es rápido y sin coste de razonamiento. Si se fuerza un modelo "pensante"
        // (flash-latest), el reintento de doGemini se encarga si hiciera falta.
      }
    });
  }

  /* =========================================================================
   * FALLBACK: WhatsApp y Llamada
   * =======================================================================*/
  function normalizarTelefono(raw) {
    var digits = String(raw).replace(/[^\d+]/g, '').replace(/^\+/, '');
    if (digits.length === 9) digits = '34' + digits; // España sin prefijo
    return digits;
  }
  function generarEnlaceWhatsApp(telefono, preguntaUsuario) {
    var numero = normalizarTelefono(telefono);
    var mensaje = T.waIntro + '"' + preguntaUsuario + '"';
    return 'https://wa.me/' + numero + '?text=' + encodeURIComponent(mensaje);
  }

  /* =========================================================================
   * DETECCIÓN DE TEMA (claro/oscuro) según el fondo real de la web host
   * =======================================================================*/
  function luminance(rgb) {
    // Solo entendemos rgb()/rgba(). Con oklch/display-p3/etc. devolvemos null
    // para que detectTheme caiga a prefers-color-scheme en vez de adivinar mal.
    if (!/^rgba?\(/i.test(rgb)) return null;
    var m = rgb.match(/[\d.]+/g);
    if (!m) return 1;
    var r = +m[0], g = +m[1], b = +m[2], a = m[3] !== undefined ? +m[3] : 1;
    if (a < 0.5) return 1; // transparente => trátalo como claro
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  function effectiveBg() {
    var el = document.body;
    while (el && el !== document.documentElement.parentNode) {
      var bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba?\([^)]*,\s*0\)/.test(bg)) return bg;
      el = el.parentElement;
    }
    return getComputedStyle(document.documentElement).backgroundColor || 'rgb(255,255,255)';
  }
  // Marcador EXPLÍCITO de tema en <html>/<body>. Es la señal más fiable y es
  // instantánea: no depende de medir colores, así que no la afecta la
  // transición CSS del toggle día/noche de la web (que dura ~300ms y hacía
  // que la luminancia se midiera a medio camino y saliera el tema equivocado).
  function readThemeMarker() {
    var nodes = [document.documentElement, document.body];
    var attrs = ['data-theme', 'data-bs-theme', 'data-color-scheme', 'data-mode', 'data-scheme'];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el) continue;
      for (var a = 0; a < attrs.length; a++) {
        var v = (el.getAttribute(attrs[a]) || '').toLowerCase();
        if (v.indexOf('dark') >= 0 || v.indexOf('noche') >= 0) return 'dark';
        if (v.indexOf('light') >= 0 || v.indexOf('dia') >= 0) return 'light';
      }
      var cls = ' ' + (typeof el.className === 'string' ? el.className : '') + ' ';
      if (/\s(dark|dark-mode|darkmode|night|is-dark|theme-dark)\s/i.test(cls)) return 'dark';
      if (/\s(light|light-mode|lightmode|day|is-light|theme-light)\s/i.test(cls)) return 'light';
    }
    return null;
  }

  function detectTheme() {
    if (CFG.theme === 'dark' || CFG.theme === 'light') return CFG.theme;
    var marker = readThemeMarker();
    if (marker) return marker;
    try {
      var lum = luminance(effectiveBg());
      if (lum != null) {
        if (lum < 0.4) return 'dark';
        if (lum > 0.6) return 'light';
      }
    } catch (e) {}
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  }

  function applyTheme() {
    if (els.root) els.root.setAttribute('data-cbw-theme', detectTheme());
  }

  /* =========================================================================
   * ICONOS (SVG inline, sin dependencias)
   * =======================================================================*/
  var ICONS = {
    close: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    send: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    arrow: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>',
    wa: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.2-1.7-.8-1.9-.9-.3-.1-.5-.2-.6.1-.2.3-.7.9-.8 1-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.5-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5-.1-.2-.6-1.5-.9-2-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.3.3-1 .9-1 2.3s1 2.7 1.2 2.9c.1.2 2 3.1 4.9 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.5-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3zM12 2a10 10 0 0 0-8.6 15L2 22l5.1-1.3A10 10 0 1 0 12 2z"/></svg>',
    call: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2z"/></svg>'
  };

  /* =========================================================================
   * CONSTRUCCIÓN DE LA UI  (lanzador-barra + conversación tipográfica)
   * =======================================================================*/
  var els = {};
  var state = { open: false, busy: false, biz: null, greeted: false, lastSpeaker: null };

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html; // solo iconos SVG propios (de confianza)
    return n;
  }

  // Etiqueta del que habla en cada turno (nombre real del negocio para el bot).
  function botTag() {
    var nm = (state.biz && state.biz.nombreNegocio) || detectBusinessName();
    return nm.slice(0, 24);
  }

  function buildUI() {
    var root = el('div', 'cbw-root');
    root.id = 'cbw-root';
    root.setAttribute('data-cbw-theme', detectTheme());
    if (ACCENT) root.style.setProperty('--cbw-accent', ACCENT);
    if (ACCENT) root.style.setProperty('--cbw-accent-ink', '#fff');
    if (FONT) root.style.setProperty('--cbw-font', FONT === 'inherit' ? 'inherit' : FONT);

    // --- Lanzador: barra "Pregúntanos", NO un círculo con bocadillo ---
    var launch = el('button', 'cbw-launch');
    launch.type = 'button';
    launch.setAttribute('aria-label', T.ask);
    launch.setAttribute('aria-expanded', 'false');
    var lDot = el('span', 'cbw-launch-dot');
    var lLabel = el('span', 'cbw-launch-label'); lLabel.textContent = T.ask;
    var lArrow = el('span', 'cbw-launch-arrow', ICONS.arrow);
    launch.appendChild(lDot); launch.appendChild(lLabel); launch.appendChild(lArrow);
    // Pulso de aviso una sola vez en la vida.
    if (!lsGet(LS_SEEN)) { launch.classList.add('cbw-pulse'); lsSet(LS_SEEN, '1'); }

    // --- Panel ---
    var panel = el('div', 'cbw-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', T.dialog);

    // Cabecera: identidad tipográfica (nombre + estado en mono), sin avatar.
    var head = el('div', 'cbw-head');
    var id = el('div', 'cbw-id');
    var name = el('div', 'cbw-name'); name.textContent = detectBusinessName();
    var status = el('div', 'cbw-status');
    var sDot = el('span', 'cbw-status-dot');
    var sLabel = el('span', 'cbw-status-label'); sLabel.textContent = T.online;
    status.appendChild(sDot); status.appendChild(sLabel);
    id.appendChild(name); id.appendChild(status);
    var closeBtn = el('button', 'cbw-x', ICONS.close);
    closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', T.close);
    head.appendChild(id); head.appendChild(closeBtn);

    // Hilo (transcript). role=log + aria-live para lectores de pantalla.
    var thread = el('div', 'cbw-thread');
    thread.setAttribute('role', 'log');
    thread.setAttribute('aria-live', 'polite');
    thread.setAttribute('aria-relevant', 'additions text');

    // Compositor: línea de escritura + enviar.
    var compose = el('div', 'cbw-compose');
    var field = el('textarea', 'cbw-field');
    field.rows = 1;
    field.setAttribute('placeholder', T.placeholder);
    field.setAttribute('aria-label', T.placeholder);
    var send = el('button', 'cbw-send', ICONS.send);
    send.type = 'button'; send.setAttribute('aria-label', T.send);
    compose.appendChild(field); compose.appendChild(send);

    var foot = el('div', 'cbw-foot'); foot.textContent = T.credit;

    panel.appendChild(head); panel.appendChild(thread);
    panel.appendChild(compose); panel.appendChild(foot);
    root.appendChild(panel); root.appendChild(launch);
    document.body.appendChild(root);

    els = {
      root: root, launch: launch, launchDot: lDot, panel: panel, name: name,
      status: status, statusLabel: sLabel, thread: thread, field: field, send: send
    };

    launch.addEventListener('click', toggle);
    closeBtn.addEventListener('click', close);
    send.addEventListener('click', onSend);
    field.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return; // no enviar a mitad de un acento/IME
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
    });
    field.addEventListener('input', autoGrow);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.open) close();
    });
    panel.addEventListener('keydown', trapFocus);
    watchLocale();   // sigue los cambios de <html lang> del selector ES/EN de la web
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewport);
      window.visualViewport.addEventListener('scroll', syncViewport);
    }

    avoidCollision();
    setTimeout(avoidCollision, 1600); // por si el WhatsApp de la web carga tarde
    var rzT;
    window.addEventListener('resize', function () { clearTimeout(rzT); rzT = setTimeout(avoidCollision, 200); });
  }

  function autoGrow() {
    var f = els.field;
    f.style.height = 'auto';
    f.style.height = Math.min(f.scrollHeight, 104) + 'px';
  }

  /* ---- Apertura / cierre --------------------------------------------------*/
  function isMobile() { return window.matchMedia('(max-width: 480px)').matches; }
  function toggle() { state.open ? close() : open(); }

  function open() {
    state.open = true;
    els.root.classList.add('cbw-is-open');
    els.launch.classList.remove('cbw-pulse');
    els.launch.setAttribute('aria-expanded', 'true');
    lsSet(LS_SEEN, '1');
    els.panel.setAttribute('aria-modal', 'true');
    if (isMobile()) document.documentElement.classList.add('cbw-lock');
    renderHistory();
    if (!state.greeted && ssGet(SS_HISTORY, []).length === 0) greet();
    setTimeout(function () { els.field.focus(); }, 280);
    ensureBusiness();
  }

  function close() {
    state.open = false;
    els.root.classList.remove('cbw-is-open');
    els.panel.setAttribute('aria-modal', 'false');
    els.launch.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('cbw-lock');
    els.panel.style.bottom = ''; els.panel.style.height = ''; // limpia ajuste de teclado
    els.launch.focus();
  }

  // Móvil: al abrir el teclado, sube la hoja por encima de él y ajusta su alto
  // (dvh no encoge con el teclado; sin esto se tapaba el campo de escritura).
  function syncViewport() {
    var p = els.panel; if (!p) return;
    var vv = window.visualViewport;
    if (!vv || !state.open || !isMobile()) { p.style.bottom = ''; p.style.height = ''; return; }
    var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    if (kb > 80) { p.style.bottom = kb + 'px'; p.style.height = Math.round(vv.height * 0.98) + 'px'; }
    else { p.style.bottom = ''; p.style.height = ''; }
  }

  // Atrapa el foco dentro del panel abierto (Tab/Shift+Tab hacen bucle).
  function trapFocus(e) {
    if (e.key !== 'Tab' || !state.open) return;
    var f = [].slice.call(els.panel.querySelectorAll('button,a[href],textarea,[tabindex]:not([tabindex="-1"])'))
      .filter(function (n) { return n.offsetWidth || n.offsetHeight || n === document.activeElement; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ---- Colisión con el botón de WhatsApp fijo de la web (sube el lanzador) */
  function avoidCollision() {
    try {
      els.launch.style.bottom = ''; // limpia offset previo por si la colisión desapareció
      var vw = window.innerWidth, vh = window.innerHeight;
      var nodes = document.body.querySelectorAll('a,div,button,span');
      var lift = 0;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (els.root.contains(n)) continue;
        var cs = getComputedStyle(n);
        if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
        var r = n.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.width > 170 || r.height > 170) continue;
        if (r.right > vw - 90 && r.bottom > vh - 110) { lift = Math.min(r.height + 24, 120); break; }
      }
      if (!lift) return;
      var edge = isMobile() ? '16px' : 'var(--cbw-gap)';
      els.launch.style.bottom = 'calc(' + edge + ' + ' + lift + 'px + env(safe-area-inset-bottom, 0px))';
    } catch (e) {}
  }

  /* ---- Render de la conversación (turnos con etiqueta, sin globos) --------*/
  function scrollDown() { els.thread.scrollTop = els.thread.scrollHeight; }

  function addTurn(role, text) {
    var isUser = role === 'user';
    var same = state.lastSpeaker === role; // agrupa turnos seguidos del mismo hablante
    state.lastSpeaker = role;
    var turn = el('div', 'cbw-turn ' + (isUser ? 'cbw-turn-user' : 'cbw-turn-bot') + (same ? ' cbw-same' : ''));
    if (!same) { var tag = el('div', 'cbw-tag'); tag.textContent = isUser ? T.you : botTag(); turn.appendChild(tag); }
    var body = el('div', 'cbw-text'); body.textContent = text; // textContent: seguro
    turn.appendChild(body);
    els.thread.appendChild(turn);
    scrollDown();
    return turn;
  }

  function showTyping() {
    var turn = el('div', 'cbw-turn cbw-turn-bot');
    var tag = el('div', 'cbw-tag'); tag.textContent = botTag();
    var t = el('div', 'cbw-typing', '<i></i><i></i><i></i>');
    turn.appendChild(tag); turn.appendChild(t);
    els.thread.appendChild(turn);
    scrollDown();
    return turn;
  }

  function pushHistory(role, text) {
    var h = ssGet(SS_HISTORY, []);
    h.push({ role: role, text: text });
    ssSet(SS_HISTORY, h.slice(-30));
  }

  function renderHistory() {
    els.thread.setAttribute('aria-live', 'off'); // no re-anunciar el volcado en bloque
    els.thread.innerHTML = '';
    state.lastSpeaker = null;
    var h = ssGet(SS_HISTORY, []);
    h.forEach(function (m) {
      var hadNoInfo = m.text.indexOf(NO_INFO) >= 0;
      var text = m.text.replace(NO_INFO, '').trim();
      if (hadNoInfo && !text) text = fallbackText(); // sentinela solo => mismo texto que en vivo
      var turn = addTurn(m.role === 'user' ? 'user' : 'bot', text);
      if (hadNoInfo && m.role === 'model') attachFallback(turn, lastUserQuestion(h, m));
    });
    if (h.length) state.greeted = true;
    setTimeout(function () { els.thread.setAttribute('aria-live', 'polite'); }, 60);
  }

  function lastUserQuestion(history, modelMsg) {
    var idx = history.indexOf(modelMsg);
    for (var i = idx - 1; i >= 0; i--) if (history[i].role === 'user') return history[i].text;
    return '';
  }

  function greet() {
    state.greeted = true;
    var name = (state.biz && state.biz.nombreNegocio) || detectBusinessName();
    addTurn('bot', T.greet.replace('{name}', name));
    renderSuggestions();
  }

  function renderSuggestions() {
    var wrap = el('div', 'cbw-suggest');
    T.sugg.forEach(function (q) {
      var s = el('button', 'cbw-sug'); s.type = 'button'; s.textContent = q;
      s.addEventListener('click', function () {
        // Se lee la etiqueta ACTUAL (no la capturada): si la web cambia de idioma,
        // el chip ya se ha reescrito y debe enviarse la pregunta en ese idioma.
        wrap.remove(); els.field.value = this.textContent; onSend();
      });
      wrap.appendChild(s);
    });
    els.thread.appendChild(wrap);
    scrollDown();
  }

  /* ---- Contacto directo (WhatsApp / Llamar) bajo un turno del bot ---------*/
  function attachFallback(botTurn, question) {
    var phone = state.biz && state.biz.telefono;
    if (!phone) return; // sin teléfono, no mostramos botones rotos
    var actions = el('div', 'cbw-actions');

    var wa = el('a', 'cbw-act cbw-act-wa', ICONS.wa + '<span></span>');
    wa.querySelector('span').textContent = T.wa;
    wa.href = generarEnlaceWhatsApp(phone, question || '');
    wa.target = '_blank'; wa.rel = 'noopener noreferrer';

    var call = el('a', 'cbw-act cbw-act-call', ICONS.call + '<span></span>');
    call.querySelector('span').textContent = T.call;
    call.href = 'tel:' + normalizarTelefono(phone);

    actions.appendChild(wa); actions.appendChild(call);
    botTurn.appendChild(actions);
    scrollDown();
  }

  /* ---- Envío --------------------------------------------------------------*/
  function ensureBusiness() {
    if (state.biz) return Promise.resolve(state.biz);
    return buildBusinessData().then(function (biz) {
      state.biz = biz;
      applyBusinessToHeader(biz);
      return biz;
    });
  }

  function applyBusinessToHeader(biz) {
    var name = (biz && biz.nombreNegocio) || detectBusinessName();
    els.name.textContent = name;
    els.launch.setAttribute('aria-label', T.ask + ' - ' + name);
    var st = biz && getOpenStatus(biz.horario);
    if (st) {
      els.status.classList.toggle('cbw-open', !!st.abierto);
      els.launch.classList.toggle('cbw-on', !!st.abierto);
      els.statusLabel.textContent = st.abierto ? T.open : T.closed;
    } else {
      els.statusLabel.textContent = T.online;
    }
  }

  /* La web puede cambiar de idioma DESPUÉS de que cargue el widget (selector ES/EN).
     Sin esto, el panel se quedaba en el idioma inicial mientras la página ya estaba
     en el otro (p.ej. "Pregúntanos" en una página en inglés) — incumple la norma
     bilingüe. Se reaplican los textos estáticos; el historial de la charla no se toca. */
  function applyLocale() {
    var nuevo = detectLocale();
    if (nuevo === LOCALE) return;
    LOCALE = nuevo;
    T = I18N[LOCALE] || I18N.es;
    if (!els.root) return;
    var q = function (sel) { return els.root.querySelector(sel); };
    var lbl = q('.cbw-launch-label'); if (lbl) lbl.textContent = T.ask;
    if (els.panel) els.panel.setAttribute('aria-label', T.dialog);
    if (els.field) { els.field.setAttribute('placeholder', T.placeholder); els.field.setAttribute('aria-label', T.placeholder); }
    if (els.send) els.send.setAttribute('aria-label', T.send);
    var x = q('.cbw-x'); if (x) x.setAttribute('aria-label', T.close);
    var foot = q('.cbw-foot'); if (foot) foot.textContent = T.credit;
    var chips = els.root.querySelectorAll('.cbw-sug');
    if (chips.length === T.sugg.length) {
      for (var i = 0; i < chips.length; i++) chips[i].textContent = T.sugg[i];
    }
    applyBusinessToHeader(state.biz);
  }

  function watchLocale() {
    if (!('MutationObserver' in window)) return;
    new MutationObserver(applyLocale).observe(document.documentElement, {
      attributes: true, attributeFilter: ['lang']
    });
  }

  function onSend() {
    var text = els.field.value.trim();
    if (!text || state.busy) return;

    var sugg = els.thread.querySelector('.cbw-suggest');
    if (sugg) sugg.remove();

    els.field.value = '';
    autoGrow();
    addTurn('user', text);
    pushHistory('user', text);

    state.busy = true;
    els.send.disabled = true;
    els.thread.setAttribute('aria-busy', 'true'); // señal "escribiendo" para lectores de pantalla
    var typing = showTyping();

    ensureBusiness().then(function (biz) {
      return answerQuestion(biz, text);
    }).then(function (answer) {
      typing.remove();
      if (!answer) answer = NO_INFO; // respuesta vacía => tratar como "no lo sé"
      var hadNoInfo = answer.indexOf(NO_INFO) >= 0;
      var clean = answer.replace(NO_INFO, '').trim();
      if (!clean) clean = fallbackText();
      pushHistory('model', answer);
      var turn = addTurn('bot', clean);
      if (hadNoInfo) attachFallback(turn, text);
    }).catch(function (err) {
      typing.remove();
      var kind = err && err.kind;
      var turn = addTurn('bot', kind === 'quota' ? (T.apiBusy || T.apiError) : T.apiError);
      attachFallback(turn, text); // SIEMPRE ofrece WhatsApp/llamar aunque la API falle
      ownerDiagnostic(kind, err); // aviso claro para el dueño de la web en consola
    }).then(function () {
      state.busy = false;
      els.send.disabled = false;
      els.thread.setAttribute('aria-busy', 'false');
      els.field.focus();
    });
  }

  // Diagnóstico para el DUEÑO de la web (una vez por tipo de fallo): así, si el
  // bot no responde, en la consola (F12) aparece la causa exacta y cómo resolverla.
  var _diagShown = {};
  function ownerDiagnostic(kind, err) {
    if (!window.console) return;
    console.warn('[chatbot-widget]', (err && err.message) || err);
    if (_diagShown[kind]) return;
    _diagShown[kind] = true;
    if (kind === 'auth') {
      console.error('%c[chatbot-widget] La API key de Gemini NO es válida o está restringida.',
        'color:#c0392b;font-weight:bold;font-size:13px');
      console.error('[chatbot-widget] Solución: genera una key en https://aistudio.google.com/apikey, ' +
        'ponla en data-gemini-key y restríngela por dominio. Ojo: las keys que empiezan por "AQ." ' +
        'suelen darse tras exponer una key y pueden fallar; intenta obtener una que empiece por "AIza".');
    } else if (kind === 'quota') {
      console.error('[chatbot-widget] Cuota de Gemini agotada hoy (plan gratis). El widget ya prueba ' +
        'varios modelos. Para tráfico real activa facturación en Google Cloud, o espera al reset ' +
        '(medianoche hora del Pacífico). Consumo: https://ai.dev/rate-limit');
    } else if (kind === 'network') {
      console.error('[chatbot-widget] No se pudo contactar con Gemini (red/CORS/timeout). ' +
        'Revisa la conexión y que la CSP de la web permita conectar con generativelanguage.googleapis.com.');
    }
  }

  function fallbackText() {
    // Texto neutro (localizado) cuando el modelo solo devolvió el sentinela.
    return T.noInfo || '';
  }

  /* =========================================================================
   * AUTO-ACTUALIZACIÓN: si la página cambia, re-extraer sin recargar
   * =======================================================================*/
  function actualizarContexto() {
    updatePagesStore();
    applyTheme(); // por si la web cambió de tema
    avoidCollision(); // por si un WhatsApp flotante de terceros cargó tarde

    // Refresca el estado abierto/cerrado del header (la hora avanza).
    if (state.biz) applyBusinessToHeader(state.biz);
  }

  function observeMutations() {
    var debounce;
    var mo = new MutationObserver(function (records) {
      // Ignora mutaciones que provienen de nuestro propio widget.
      var external = records.some(function (r) {
        return !(els.root && els.root.contains(r.target));
      });
      if (!external) return;
      clearTimeout(debounce);
      debounce = setTimeout(actualizarContexto, 2000);
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Cambios de tema de la web (toggle día/noche): observamos <html> Y <body>.
    // El re-chequeo va con 420ms de retardo a propósito: si la web anima el
    // fondo (transition ~300ms), medir de inmediato daría el color a medias.
    var themeTimer;
    var reTheme = function () {
      clearTimeout(themeTimer);
      themeTimer = setTimeout(applyTheme, 420);
    };
    var themeObs = new MutationObserver(reTheme);
    var themeAttrs = ['class', 'data-theme', 'data-bs-theme', 'data-color-scheme',
                      'data-mode', 'data-scheme', 'style'];
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: themeAttrs });
    if (document.body) themeObs.observe(document.body, { attributes: true, attributeFilter: themeAttrs });

    // Y si el usuario cambia el tema del sistema operativo.
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', applyTheme);
      else if (mq.addListener) mq.addListener(applyTheme);
    }

    // El estado abierto/cerrado del header se refresca cada minuto.
    setInterval(function () { if (state.biz) applyBusinessToHeader(state.biz); }, 60000);
  }

  /* =========================================================================
   * ARRANQUE
   * =======================================================================*/
  function init() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', init); return; }
    if (!API_KEY && !PROXY && window.console) {
      console.error('%c[chatbot-widget] Falta data-gemini-key (o data-endpoint). El chat se ve, ' +
        'pero no podrá responder. Pon tu API key de Gemini en el <script> del loader.',
        'color:#c0392b;font-weight:bold');
    }
    updatePagesStore();      // guarda el contenido de esta página
    buildUI();               // pinta FAB + panel (cerrado)
    // Re-chequeo de tema: cubre webs que aplican su tema tarde (script de
    // preferencia guardada) o que arrancan a mitad de una transición de color.
    setTimeout(applyTheme, 600);
    observeMutations();      // vigila cambios de la web
    // Fase 1 en segundo plano (sin bloquear): así el header muestra nombre/estado
    // y la primera respuesta es instantánea.
    ensureBusiness();
  }

  init();
})();
