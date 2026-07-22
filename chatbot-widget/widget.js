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

  // --- Modelo de Gemini ----------------------------------------------------
  // Por defecto el ALIAS "gemini-flash-lite-latest" (hoy = gemini-3.1-flash-lite):
  //  · se actualiza solo al Flash-Lite más reciente (cero mantenimiento), y
  //  · su CUOTA GRATIS es MUCHO más alta que la del flash tope de gama
  //    (gemini-3.5-flash free tier = solo 20 peticiones/día → un negocio lo
  //    agota en una tarde). La cuota es POR MODELO, así que Lite tiene su propio
  //    cupo, amplio. Para esta tarea (leer la web y responder) Lite sobra.
  // Si algún día quieres más "cabeza" (horarios muy enrevesados) y tienes
  // facturación activada, pon data-gemini-model="gemini-flash-latest".
  // Nota: Google apaga modelos con frecuencia (1.5 y 2.0 ya no van); si deja de
  // responder, revisa el nombre vigente en ai.google.dev/gemini-api/docs/models.
  var GEMINI_MODEL = CFG.model || 'gemini-flash-lite-latest';

  var GEMINI_ENDPOINT =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(GEMINI_MODEL) + ':generateContent';

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
    es: { placeholder:'Escribe tu mensaje…', online:'En línea', open:'Abierto', closed:'Cerrado',
          send:'Enviar', close:'Cerrar', wa:'Escribir por WhatsApp', call:'Llamar',
          apiError:'Ahora mismo no puedo responder. Inténtalo de nuevo o escríbenos por WhatsApp.',
          greet:'¡Hola! 👋 Soy el asistente de {name}. ¿En qué puedo ayudarte?',
          waIntro:'Hola, vengo de la página web y tengo una duda: ',
          credit:'Asistente con IA' ,
          sugg:['¿Qué servicios ofrecéis?','¿Estáis abiertos ahora?','¿Dónde estáis?'] },
    en: { placeholder:'Type your message…', online:'Online', open:'Open', closed:'Closed',
          send:'Send', close:'Close', wa:'Message on WhatsApp', call:'Call',
          apiError:"I can't reply right now. Please try again or message us on WhatsApp.",
          greet:'Hi! 👋 I\'m {name}\'s assistant. How can I help?',
          waIntro:'Hi, I\'m coming from your website and I have a question: ',
          credit:'AI assistant',
          sugg:['What do you offer?','Are you open now?','Where are you?'] },
    fr: { placeholder:'Écrivez votre message…', online:'En ligne', open:'Ouvert', closed:'Fermé',
          send:'Envoyer', close:'Fermer', wa:'Écrire sur WhatsApp', call:'Appeler',
          apiError:"Je ne peux pas répondre pour le moment. Réessayez ou écrivez-nous sur WhatsApp.",
          greet:'Bonjour ! 👋 Je suis l\'assistant de {name}. Comment puis-je aider ?',
          waIntro:'Bonjour, je viens de votre site web et j\'ai une question : ',
          credit:'Assistant IA',
          sugg:['Quels services proposez-vous ?','Êtes-vous ouverts ?','Où êtes-vous ?'] },
    de: { placeholder:'Nachricht schreiben…', online:'Online', open:'Geöffnet', closed:'Geschlossen',
          send:'Senden', close:'Schließen', wa:'Auf WhatsApp schreiben', call:'Anrufen',
          apiError:'Ich kann gerade nicht antworten. Bitte erneut versuchen oder per WhatsApp schreiben.',
          greet:'Hallo! 👋 Ich bin der Assistent von {name}. Wie kann ich helfen?',
          waIntro:'Hallo, ich komme von Ihrer Website und habe eine Frage: ',
          credit:'KI-Assistent',
          sugg:['Was bieten Sie an?','Haben Sie geöffnet?','Wo befinden Sie sich?'] },
    it: { placeholder:'Scrivi il tuo messaggio…', online:'Online', open:'Aperto', closed:'Chiuso',
          send:'Invia', close:'Chiudi', wa:'Scrivi su WhatsApp', call:'Chiama',
          apiError:'Non posso rispondere ora. Riprova o scrivici su WhatsApp.',
          greet:'Ciao! 👋 Sono l\'assistente di {name}. Come posso aiutarti?',
          waIntro:'Ciao, vengo dal vostro sito web e ho una domanda: ',
          credit:'Assistente IA',
          sugg:['Che servizi offrite?','Siete aperti ora?','Dove siete?'] },
    pt: { placeholder:'Escreve a tua mensagem…', online:'Online', open:'Aberto', closed:'Fechado',
          send:'Enviar', close:'Fechar', wa:'Escrever no WhatsApp', call:'Ligar',
          apiError:'Não consigo responder agora. Tenta de novo ou escreve-nos no WhatsApp.',
          greet:'Olá! 👋 Sou o assistente de {name}. Como posso ajudar?',
          waIntro:'Olá, venho do vosso site e tenho uma dúvida: ',
          credit:'Assistente com IA',
          sugg:['Que serviços oferecem?','Estão abertos agora?','Onde estão?'] }
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
    var skip = ['script','style','nav','footer','noscript','iframe','svg','template'];
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

  function callGemini(body) { return doGemini(body, {}); }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Dos reintentos defensivos, UNA vez cada uno:
  //  · 400 rechazando un campo de generationConfig (p.ej. thinkingConfig si un
  //    modelo futuro deja de soportarlo) -> se quita el campo y se reintenta.
  //  · 429/503 (límite por minuto o sobrecarga puntual, típico si entran varios
  //    clientes a la vez) -> espera corta y reintenta. Si es la cuota DIARIA,
  //    volverá a fallar y se muestra el fallback de WhatsApp, que es lo correcto.
  function doGemini(body, tried) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT);
    var done = function () { clearTimeout(timer); };
    return fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_KEY   // la key va en cabecera, nunca en la URL
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          // 400 por un campo no soportado -> quitarlo y reintentar
          if (!tried.noThink && res.status === 400 && body.generationConfig &&
              body.generationConfig.thinkingConfig) {
            done();
            tried.noThink = true;
            var b2 = JSON.parse(JSON.stringify(body));
            delete b2.generationConfig.thinkingConfig;
            return doGemini(b2, tried);
          }
          // 429/503 transitorio -> espera corta y un solo reintento
          if (!tried.rate && (res.status === 429 || res.status === 503)) {
            done();
            tried.rate = true;
            return wait(1500).then(function () { return doGemini(body, tried); });
          }
          done();
          throw new Error('Gemini ' + res.status + ': ' + t.slice(0, 200));
        });
      }
      return res.json().then(function (data) { done(); return extractText(data); });
    }, function (err) { done(); throw err; });
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
    if (!API_KEY) return Promise.resolve(fallbackBusiness());

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
      'Eres el asistente virtual de "' + (biz.nombreNegocio || 'este negocio') + '".',
      '',
      'DATOS VERIFICADOS (son reales y ya calculados; NO los cuestiones ni los recalcules):',
      '- Fecha y hora actuales: ' + fecha + ', ' + hora + ' (hora local del cliente).',
      '- Estado ahora mismo: ' + estado + '.',
      '- Teléfono: ' + (biz.telefono || 'no disponible') + '.',
      '- Dirección: ' + (biz.direccion || 'no disponible') + '.',
      (biz.resumenServicios ? '- Servicios (resumen): ' + biz.resumenServicios + '.' : ''),
      '',
      'CONTENIDO DE LA PÁGINA (tu ÚNICA fuente para servicios, precios, promociones,',
      'productos, ubicación, políticas y cualquier otro detalle del negocio):',
      '"""',
      allPagesText(),
      '"""',
      '',
      'REGLAS:',
      '1. Responde SOLO con los datos de arriba. Nunca inventes precios, servicios,',
      '   horarios ni datos de contacto que no aparezcan.',
      '2. Si no tienes la información exacta para responder, escribe una frase breve y',
      '   amable en el idioma del usuario invitándole a contactar directamente con el',
      '   negocio, y TERMINA tu mensaje con el token literal ' + NO_INFO + ' en una línea',
      '   aparte. No uses ese token si sí sabes responder.',
      '3. Responde SIEMPRE en el mismo idioma en que te escriba el usuario.',
      '4. Máximo 3-4 frases. Nada de rollos para preguntas simples.',
      '5. No copies literalmente frases de la página; redáctalo con tus palabras.',
      '6. Si preguntan por horario/si está abierto, usa el "Estado ahora mismo" de arriba,',
      '   tal cual, sin recalcular fechas por tu cuenta.',
      '7. Preguntas ajenas al negocio (recetas, política, etc.): declina con amabilidad y',
      '   recuerda que solo puedes ayudar con temas de esta web.'
    ].filter(Boolean).join('\n');
  }

  function answerQuestion(biz, userText) {
    var history = ssGet(SS_HISTORY, []);
    var contents = history.slice(-10).map(function (m) {
      return { role: m.role, parts: [{ text: m.text }] };
    });
    contents.push({ role: 'user', parts: [{ text: userText }] });

    return callGemini({
      systemInstruction: { parts: [{ text: buildSystemPrompt(biz) }] },
      contents: contents,
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 500,
        // Chat = respuestas ágiles: desactivamos el razonamiento del modelo.
        // (La Fase 1 sí razona para interpretar horarios raros; esto es distinto.)
        thinkingConfig: { thinkingBudget: 0 }
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
    var m = rgb.match(/\d+(\.\d+)?/g);
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
      if (lum < 0.4) return 'dark';
      if (lum > 0.6) return 'light';
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
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
    wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.2-1.7-.8-1.9-.9-.3-.1-.5-.2-.6.1-.2.3-.7.9-.8 1-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.5-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5-.1-.2-.6-1.5-.9-2-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.3.3-1 .9-1 2.3s1 2.7 1.2 2.9c.1.2 2 3.1 4.9 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.5-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3zM12 2a10 10 0 0 0-8.6 15L2 22l5.1-1.3A10 10 0 1 0 12 2z"/></svg>',
    call: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2z"/></svg>'
  };

  /* =========================================================================
   * CONSTRUCCIÓN DE LA UI
   * =======================================================================*/
  var els = {};   // referencias a nodos
  var state = { open: false, busy: false, biz: null, greeted: false };

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html; // solo para iconos SVG propios (contenido de confianza)
    return n;
  }

  function buildUI() {
    var root = el('div', 'cbw-root');
    root.id = 'cbw-root';
    root.setAttribute('data-cbw-theme', detectTheme());
    if (ACCENT) root.style.setProperty('--cbw-accent', ACCENT);
    if (FONT) root.style.setProperty('--cbw-font', FONT === 'inherit' ? 'inherit' : FONT);

    // --- FAB ---
    var fab = el('button', 'cbw-fab');
    fab.type = 'button';
    fab.setAttribute('aria-label', T.online + ' — ' + (NAME_OVERRIDE || 'chat'));
    fab.setAttribute('aria-expanded', 'false');
    var iconChat = el('span', 'cbw-fab-icon-chat', ICONS.chat);
    var iconClose = el('span', 'cbw-fab-icon-close', ICONS.close);
    fab.appendChild(iconChat); fab.appendChild(iconClose);
    // Pulso de aviso UNA sola vez en la vida (primera carga). Marcamos cbw_seen
    // ya, para que no vuelva a pulsar en cargas siguientes aunque no lo abran.
    if (!lsGet(LS_SEEN)) { fab.classList.add('cbw-pulse'); lsSet(LS_SEEN, '1'); }

    // --- Panel ---
    var panel = el('div', 'cbw-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'Chat de atención al cliente');

    // Header
    var header = el('div', 'cbw-header');
    var avatar = el('div', 'cbw-avatar');
    var headText = el('div', 'cbw-head-text');
    var title = el('div', 'cbw-title'); title.textContent = 'Asistente';
    var status = el('div', 'cbw-status');
    var dot = el('span', 'cbw-status-dot');
    var statusLabel = el('span', 'cbw-status-label'); statusLabel.textContent = T.online;
    status.appendChild(dot); status.appendChild(statusLabel);
    headText.appendChild(title); headText.appendChild(status);
    var closeBtn = el('button', 'cbw-close', ICONS.close);
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', T.close);
    header.appendChild(avatar); header.appendChild(headText); header.appendChild(closeBtn);

    // Mensajes. role=log + aria-live para que un lector de pantalla anuncie
    // las respuestas del bot según llegan (si no, el usuario ciego no se entera).
    var messages = el('div', 'cbw-messages');
    messages.setAttribute('role', 'log');
    messages.setAttribute('aria-live', 'polite');
    messages.setAttribute('aria-relevant', 'additions text');

    // Barra de entrada
    var inputbar = el('div', 'cbw-inputbar');
    var textarea = el('textarea', 'cbw-textarea');
    textarea.rows = 1;
    textarea.setAttribute('placeholder', T.placeholder);
    textarea.setAttribute('aria-label', T.placeholder);
    var sendBtn = el('button', 'cbw-send', ICONS.send);
    sendBtn.type = 'button';
    sendBtn.setAttribute('aria-label', T.send);
    inputbar.appendChild(textarea); inputbar.appendChild(sendBtn);

    // Footer discreto
    var footer = el('div', 'cbw-footer');
    footer.innerHTML = '<b>' + T.credit + '</b>';

    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(inputbar);
    panel.appendChild(footer);

    root.appendChild(panel);
    root.appendChild(fab);
    document.body.appendChild(root);

    els = {
      root: root, fab: fab, panel: panel, avatar: avatar, title: title,
      status: status, statusLabel: statusLabel, messages: messages,
      textarea: textarea, sendBtn: sendBtn
    };

    // --- Eventos ---
    fab.addEventListener('click', toggle);
    closeBtn.addEventListener('click', close);
    sendBtn.addEventListener('click', onSend);
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
    });
    textarea.addEventListener('input', autoGrow);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.open) close();
    });

    avoidCollision();
    // Algunas webs cargan su botón de WhatsApp tarde; recomprobamos.
    setTimeout(avoidCollision, 1600);
  }

  function autoGrow() {
    var ta = els.textarea;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 96) + 'px';
  }

  /* ---- Apertura / cierre --------------------------------------------------*/
  function isMobile() { return window.matchMedia('(max-width: 480px)').matches; }

  function toggle() { state.open ? close() : open(); }

  function open() {
    state.open = true;
    els.root.classList.add('cbw-is-open');
    els.fab.classList.remove('cbw-pulse');
    els.fab.setAttribute('aria-expanded', 'true');
    lsSet(LS_SEEN, '1');
    if (isMobile()) {
      document.documentElement.classList.add('cbw-lock');
      els.panel.style.bottom = ''; // en móvil manda el CSS (pantalla completa)
    }
    renderHistory();
    if (!state.greeted && ssGet(SS_HISTORY, []).length === 0) greet();
    setTimeout(function () { els.textarea.focus(); }, 260);
    ensureBusiness(); // dispara la Fase 1 si aún no está
  }

  function close() {
    state.open = false;
    els.root.classList.remove('cbw-is-open');
    els.fab.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('cbw-lock');
    els.fab.focus();
  }

  /* ---- Colisión con otros flotantes (WhatsApp fijo, etc.) -----------------*/
  function avoidCollision() {
    try {
      var vw = window.innerWidth, vh = window.innerHeight;
      var nodes = document.body.querySelectorAll('a,div,button,span');
      var lift = 0;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (els.root.contains(n)) continue;
        var cs = getComputedStyle(n);
        if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
        var r = n.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.width > 160 || r.height > 160) continue;
        // ¿otro flotante pegado a la esquina inferior derecha?
        if (r.right > vw - 90 && r.bottom > vh - 110) {
          lift = Math.min(r.height + 26, 120);
          break;
        }
      }
      if (!lift) return;
      var safe = ' + env(safe-area-inset-bottom, 0px)';
      if (isMobile()) {
        els.fab.style.bottom = 'calc(16px + ' + lift + 'px' + safe + ')';
      } else {
        els.fab.style.bottom = 'calc(var(--cbw-gap-edge) + ' + lift + 'px' + safe + ')';
        // El panel sube lo mismo para no quedar tapado por el FAB elevado.
        els.panel.style.bottom = 'calc(var(--cbw-gap-edge) + ' + (lift + 56 + 14) + 'px' + safe + ')';
      }
    } catch (e) {}
  }

  /* ---- Render de mensajes -------------------------------------------------*/
  function scrollDown() { els.messages.scrollTop = els.messages.scrollHeight; }

  function addBubble(role, text) {
    var row = el('div', 'cbw-row ' + (role === 'user' ? 'cbw-user' : 'cbw-bot'));
    var col = el('div', 'cbw-col');           // columna: burbuja + (fallback debajo)
    var bubble = el('div', 'cbw-bubble');
    bubble.textContent = text; // SIEMPRE textContent: nada de HTML sin escapar
    col.appendChild(bubble);
    row.appendChild(col);
    els.messages.appendChild(row);
    scrollDown();
    return row;
  }

  function showTyping() {
    var row = el('div', 'cbw-row cbw-bot cbw-typing-row');
    var t = el('div', 'cbw-typing', '<span></span><span></span><span></span>');
    row.appendChild(t);
    els.messages.appendChild(row);
    scrollDown();
    return row;
  }

  function pushHistory(role, text) {
    var h = ssGet(SS_HISTORY, []);
    h.push({ role: role, text: text });
    ssSet(SS_HISTORY, h.slice(-30));
  }

  function renderHistory() {
    els.messages.innerHTML = '';
    var h = ssGet(SS_HISTORY, []);
    h.forEach(function (m) {
      var text = m.text;
      var hadNoInfo = text.indexOf(NO_INFO) >= 0;
      text = text.replace(NO_INFO, '').trim();
      var row = addBubble(m.role === 'user' ? 'user' : 'bot', text);
      if (hadNoInfo && m.role === 'model') attachFallback(row, lastUserQuestion(h, m));
    });
    if (h.length) state.greeted = true;
  }

  function lastUserQuestion(history, modelMsg) {
    var idx = history.indexOf(modelMsg);
    for (var i = idx - 1; i >= 0; i--) if (history[i].role === 'user') return history[i].text;
    return '';
  }

  function greet() {
    state.greeted = true;
    var name = (state.biz && state.biz.nombreNegocio) || detectBusinessName();
    addBubble('bot', T.greet.replace('{name}', name));
    renderSuggestions();
  }

  function renderSuggestions() {
    var wrap = el('div', 'cbw-suggestions');
    T.sugg.forEach(function (q) {
      var chip = el('button', 'cbw-chip');
      chip.type = 'button';
      chip.textContent = q;
      chip.addEventListener('click', function () {
        wrap.remove();
        els.textarea.value = q;
        onSend();
      });
      wrap.appendChild(chip);
    });
    els.messages.appendChild(wrap);
    scrollDown();
  }

  /* ---- Botones de fallback bajo un mensaje --------------------------------*/
  function attachFallback(botRow, question) {
    var phone = state.biz && state.biz.telefono;
    if (!phone) return; // sin teléfono no mostramos botones rotos
    var actions = el('div', 'cbw-actions');

    var wa = el('a', 'cbw-action cbw-action-wa', ICONS.wa + '<span></span>');
    wa.querySelector('span').textContent = T.wa;
    wa.href = generarEnlaceWhatsApp(phone, question || '');
    wa.target = '_blank'; wa.rel = 'noopener noreferrer';

    var call = el('a', 'cbw-action cbw-action-call', ICONS.call + '<span></span>');
    call.querySelector('span').textContent = T.call;
    call.href = 'tel:' + normalizarTelefono(phone);

    actions.appendChild(wa); actions.appendChild(call);
    (botRow.querySelector('.cbw-col') || botRow).appendChild(actions);
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
    els.title.textContent = name;
    els.avatar.textContent = (name.trim()[0] || 'A');
    els.fab.setAttribute('aria-label', name + ' — chat');
    // Estado abierto/cerrado en el header (calculado en JS).
    var st = biz && getOpenStatus(biz.horario);
    if (st) {
      els.status.classList.toggle('cbw-open', !!st.abierto);
      els.statusLabel.textContent = st.abierto ? T.open : T.closed;
    } else {
      els.statusLabel.textContent = T.online;
    }
  }

  function onSend() {
    var text = els.textarea.value.trim();
    if (!text || state.busy) return;

    // limpia sugerencias iniciales si siguen
    var sugg = els.messages.querySelector('.cbw-suggestions');
    if (sugg) sugg.remove();

    els.textarea.value = '';
    autoGrow();
    addBubble('user', text);
    pushHistory('user', text);

    state.busy = true;
    els.sendBtn.disabled = true;
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
      var row = addBubble('bot', clean);
      if (hadNoInfo) attachFallback(row, text);
    }).catch(function (err) {
      typing.remove();
      var row = addBubble('bot', T.apiError);
      attachFallback(row, text); // ofrece WhatsApp aunque la API falle
      // no guardamos el error en el historial
      if (window.console) console.warn('[cbw]', err);
    }).then(function () {
      state.busy = false;
      els.sendBtn.disabled = false;
      els.textarea.focus();
    });
  }

  function fallbackText() {
    // Texto neutro cuando el modelo solo devolvió el sentinela.
    return T.greet.indexOf('{name}') >= 0
      ? (LOCALE === 'es'
          ? 'No tengo ese dato exacto en la web, pero el negocio puede ayudarte directamente:'
          : 'I don\'t have that exact detail on the site, but the business can help you directly:')
      : '';
  }

  /* =========================================================================
   * AUTO-ACTUALIZACIÓN: si la página cambia, re-extraer sin recargar
   * =======================================================================*/
  function actualizarContexto() {
    updatePagesStore();
    applyTheme(); // por si la web cambió de tema

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
    if (!API_KEY && window.console) {
      console.warn('[cbw] Falta data-gemini-key: el widget se muestra pero no podrá responder.');
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
