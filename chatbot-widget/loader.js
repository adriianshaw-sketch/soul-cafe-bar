/* ============================================================================
 * Chatbot Widget — loader.js
 * ----------------------------------------------------------------------------
 * Único punto de entrada. Se pega con UNA línea antes de </body>:
 *
 *   <script src="chatbot-widget/loader.js" data-gemini-key="TU_API_KEY"></script>
 *
 * Qué hace:
 *   1. Localiza su propia etiqueta <script> y lee la configuración de los data-*.
 *   2. Calcula la ruta base (junto a este loader) para resolver widget.css/js.
 *   3. Inyecta widget.css en <head> (la tipografía se hereda de la web anfitriona).
 *   4. Publica la config en window.CBW_CONFIG y carga widget.js.
 *
 * Atributos admitidos en la etiqueta <script>:
 *   data-gemini-key    (OBLIGATORIO) tu API key de Google Gemini
 *   data-gemini-model  (opcional) id de modelo; por defecto "gemini-flash-latest"
 *   data-phone         (opcional) fuerza el teléfono de contacto (si la web no lo expone)
 *   data-name          (opcional) fuerza el nombre del negocio
 *   data-accent        (opcional) color de acento (#hex) para adaptarlo a la marca
 *   data-theme         (opcional) "light" | "dark" para fijar el tema (por defecto: auto)
 * ==========================================================================*/
(function () {
  'use strict';

  // 1) Nuestra etiqueta <script> (currentScript durante la ejecución síncrona;
  //    con fallback por si se cargara de forma diferida).
  var me = document.currentScript ||
    (function () {
      var s = document.querySelectorAll('script[src*="loader.js"]');
      return s[s.length - 1];
    })();
  if (!me) { console.error('[cbw] No se encontró la etiqueta <script> del loader.'); return; }

  // 2) Ruta base = carpeta donde vive este loader.js.
  var base = me.src.replace(/loader\.js(\?.*)?$/, '');

  var d = me.dataset || {};
  window.CBW_CONFIG = {
    key:   d.geminiKey   || '',
    model: d.geminiModel || '',
    phone: d.phone       || '',
    name:  d.name        || '',
    accent:d.accent      || '',
    theme: d.theme       || '',
    font:  d.font        || '',
    base:  base
  };

  // 3a) Sin fuente propia: el widget HEREDA la tipografía de la web anfitriona.
  //     Antes cargaba Inter desde Google Fonts, lo que metía una fuente prohibida y una
  //     petición de red extra en cada web de cliente, y desentonaba con su tipografía.

  // 3b) Hoja de estilos del widget.
  if (!document.querySelector('link[data-cbw-css]')) {
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.setAttribute('data-cbw-css', '');
    css.href = base + 'widget.css';
    document.head.appendChild(css);
  }

  // 4) Lógica del widget.
  if (!document.querySelector('script[data-cbw-js]')) {
    var js = document.createElement('script');
    js.setAttribute('data-cbw-js', '');
    js.src = base + 'widget.js';
    js.defer = true;
    document.body.appendChild(js);
  }
})();
