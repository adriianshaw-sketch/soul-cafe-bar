# Chatbot Widget · atención al cliente auto‑configurable

Widget de chat que **se estudia solo el contenido de la web donde vive** y responde
preguntas reales de clientes. Cero configuración por proyecto: se pega con una línea
y lo lee todo por sí mismo (nombre, teléfono, dirección, horario, servicios, precios…).
Si no sabe algo, no se queda callado ni inventa: ofrece **WhatsApp** o **llamada** con
el mensaje ya redactado.

Vanilla JS. Sin frameworks, sin npm, sin backend. Funciona en cualquier web (estática,
CMS, SPA) añadiendo un `<script>`.

---

## 🔌 Integración (una sola línea antes de `</body>`)

```html
<script src="chatbot-widget/loader.js" data-gemini-key="TU_API_KEY"></script>
```

Ajusta la ruta de `loader.js` a donde subas la carpeta `chatbot-widget/`.
`loader.js` resuelve `widget.css` y `widget.js` **relativos a su propia ubicación**,
así que basta con subir la carpeta entera junto a la web.

### Atributos opcionales del `<script>`

| Atributo            | Para qué sirve                                                             |
|---------------------|---------------------------------------------------------------------------|
| `data-gemini-key`   | **(obligatorio)** tu API key de Google Gemini.                            |
| `data-gemini-model` | Fijar un modelo concreto. Por defecto usa el alias `gemini-flash-latest`. |
| `data-phone`        | Forzar el teléfono de contacto si la web no lo expone en ningún sitio.     |
| `data-name`         | Forzar el nombre del negocio (si la detección automática no acierta).      |
| `data-accent`       | Color de acento (`#hex`) para adaptar el widget a la marca.               |
| `data-theme`        | `light` o `dark` para fijar el tema. Por defecto: **automático**.          |
| `data-font`         | `inherit` para adoptar la tipografía de la web, o una familia concreta.    |
| `data-endpoint`     | URL de un proxy (Cloudflare Worker) para NO exponer la key. Ver «Modo seguro». |

Todos son opcionales salvo la key. Lo normal es **no poner ninguno**: el widget se
autoconfigura leyendo la página.

---

## 🧠 Cómo funciona (dos fases)

**Fase 1 — al cargar la página (una vez, cacheada en `sessionStorage`):**
1. Extrae el texto visible (ignora nav/footer/scripts y a sí mismo).
2. Busca datos estructurados JSON‑LD (`schema.org`, muy comunes en webs con buen SEO).
3. Manda todo eso a Gemini **una vez** y recibe un JSON con los datos clave del negocio
   (nombre, teléfono, dirección y **horario por día**). Un modelo entiende el horario
   escrito en lenguaje natural ("de martes a jueves, mediodías y noches") mucho mejor
   que una expresión regular.

**Cálculo de abierto/cerrado — SIEMPRE en JavaScript, nunca la IA.**
Con el horario de la Fase 1, el widget calcula con `new Date()` si el negocio está
abierto **ahora mismo** y cuál es la **próxima apertura** ("cerrado, abre el martes a
las 13:00"). Maneja tramos partidos y horarios de madrugada (bares: 20:00–02:00).
> Un modelo de lenguaje no sabe qué hora es; si le dejas decidir si está abierto,
> inventa. Por eso el estado se calcula en JS y se le pasa ya resuelto.

**Fase 2 — cada mensaje del usuario:**
Gemini recibe los datos ya resueltos (incluido abierto/cerrado) + el contenido de la
página + el historial, y **solo redacta** la respuesta. Reglas: responde únicamente con
lo que hay en la web, en el idioma del usuario, en 3‑4 frases, sin inventar.

**Memoria (`sessionStorage`, se reinicia en cada visita):** acumula el texto de cada
página que el usuario visite del mismo sitio (Home + Contacto…), guarda los datos de la
Fase 1 (para no repetir esa llamada) y el historial de la conversación (para que no se
borre al cambiar de página). En `localStorage` solo se guarda `cbw_seen` (si ya vio el
widget alguna vez, para no repetir el pulso de aviso).

**Auto‑actualización:** un `MutationObserver` re‑extrae el contenido si la página cambia
(menús desplegados, contenido cargado por JS, CMS) sin recargar. También sigue el
**toggle día/noche** de la web y adapta su tema automáticamente.

---

## 🎨 Diseño

- Botón flotante 56px abajo‑derecha; **nunca se abre solo** (solo con clic).
- Un único pulso sutil la primera vez; después, nunca más.
- Se autonombra con el negocio real (título/`og:site_name`) y muestra **Abierto/Cerrado**.
- Modo **claro y oscuro**, ambos cuidados; sigue el tema de la web host.
- **Móvil**: pantalla casi completa con `100dvh` (aguanta el teclado), pegado abajo,
  respeta `safe-area-inset`, bloquea el scroll del fondo.
- **Anticolisión**: si la web ya tiene un botón de WhatsApp fijo en esa esquina, el chat
  se sube solo para no solaparse.
- Responde en **muchos idiomas** (el del usuario). Textos del propio widget en ES/EN/FR/DE/IT/PT.
- Todas las clases con prefijo `.cbw-`; el texto se inserta con `textContent` (seguro).

---

## ⚠️ SEGURIDAD DE LA API KEY — un único paso manual, una vez en la vida

> La key viaja en el HTML (`data-gemini-key`), así que **cualquiera que mire el código
> fuente puede copiarla**. Es asumible para este proyecto, pero tienes que blindarla
> **UNA vez** (no por cada web). Yo no puedo hacer esto por ti porque no es código:

1. **Restringe la key a tus dominios.** En **Google AI Studio / Google Cloud Console →
   APIs y servicios → Credenciales**, edita la key y en *Restricciones de aplicación*
   elige **Referentes HTTP (sitios web)**. Añade tus dominios, p. ej.:
   ```
   https://tudominio.com/*
   https://*.tudominio.com/*
   ```
   Así la key solo funciona desde tus webs; si alguien la copia, no le sirve en otro sitio.

2. **Pon un límite de cuota diario.** En **Cloud Console → APIs y servicios →
   Generative Language API → Cuotas**, fija un tope diario de peticiones. Evita sustos de
   facturación si alguien intentara abusar de la key.

Hecho esto una vez, puedes reutilizar la misma key en todas las webs sin tocar nada más.

## 🔒 Modo seguro (recomendado): proxy, la key nunca en el HTML

Si no quieres que la key viaje en el HTML (lo ideal para producción), usa el proxy incluido
`worker.js` (un **Cloudflare Worker**, plan gratis 100.000 peticiones/día). La key vive en el
worker, el widget solo habla con el worker:

1. Crea cuenta gratis en Cloudflare → **Workers & Pages** → *Create Worker*, pega `worker.js`.
2. En el worker: **Settings → Variables and Secrets** → secreto `GEMINI_KEY` = tu API key.
   (Opcional: variable `ALLOWED_ORIGINS` = `https://tudominio.com` para restringir por dominio.)
3. En tu web, en vez de la key:
   ```html
   <script src="chatbot-widget/loader.js"
           data-endpoint="https://mi-chat.TUUSUARIO.workers.dev"></script>
   ```

Así resuelves de golpe la seguridad (la key no se ve, no se puede copiar) sin dejar de usar el
plan gratis de Gemini. Los pasos completos están comentados dentro de `worker.js`.

## 🛟 Nunca falla en silencio

Si el bot no puede responder, **el cliente siempre ve un mensaje amable + botón de WhatsApp**
(nunca se queda mudo), y **tú ves en la consola (F12) la causa exacta**: "API key no válida",
"cuota agotada" o "problema de red", con la solución. Abre la consola del navegador si dudas.

---

## 🤖 Modelo de Gemini, cuotas y mantenimiento

- Por defecto: alias **`gemini-flash-lite-latest`** (hoy = `gemini-3.1-flash-lite`). Se
  actualiza solo **sin tocar código nunca** y, sobre todo, tiene una **cuota gratuita
  mucho mayor**. Para esta tarea (leer la web y responder) va sobrado.
- **Fallback automático de modelos:** el widget prueba una lista (`flash-lite-latest` →
  `flash-latest`). Si uno da 429 (cuota) o 404 (Google lo retiró), salta solo al siguiente
  —que tiene su propia cuota—, así que aguanta el churn de modelos y los topes sin tocar nada.
- Para fijar otro modelo primero: `data-gemini-model="gemini-flash-latest"`, o cambia la
  lista `MODELS` en `widget.js`.

### ⚠️ Cuotas: lo que tienes que saber antes de poner esto en producción

La cuota gratuita de Gemini es **por modelo y por día**, y en los modelos tope de gama es
minúscula: `gemini-3.5-flash` en free tier permite **20 peticiones al día** — un negocio
con algo de tráfico lo agota en una tarde y, a partir de ahí, el bot responde
*"Ahora mismo no puedo responder…"* a **todas** las preguntas (error 429).

- Por eso el modelo por defecto es **Flash-Lite**: mismo comportamiento, cupo gratis mucho
  más amplio.
- **Para uso real en la web de un cliente, activa la facturación** en el proyecto de Google
  Cloud asociado a la key. Con facturación, los límites suben muchísimo y el coste de este
  widget es de céntimos (cada respuesta son unos pocos cientos de tokens).
- Cada visitante gasta **1 llamada de Fase 1** (solo la primera vez por visita, se cachea)
  **+ 1 llamada por mensaje**.
- El widget reintenta una vez ante 429/503 puntuales; si es la cuota diaria, degrada al
  botón de WhatsApp (que es exactamente lo que debe hacer).
- Para ver el consumo real: <https://ai.dev/rate-limit>.
- Google **desactiva modelos con frecuencia** (1.5 y 2.0 ya no funcionan; 2.5‑flash se apaga
  el 16‑oct‑2026). Si algún día el widget deja de responder, revisa el nombre del modelo en
  <https://ai.google.dev/gemini-api/docs/models>.
- La API usada es la clásica `generateContent`
  (`generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent`), con la key en
  la cabecera `x-goog-api-key`. En la conversación se desactiva el "thinking" del modelo para
  respuestas rápidas; si un modelo futuro rechazara ese campo, el widget reintenta sin él solo.

---

## 🧪 Probarlo

Incluida una página de demostración realista (`demo.html`) con JSON‑LD, horario partido y
un botón de WhatsApp fijo (para ver la anticolisión):

```bash
cd chatbot-widget
python3 -m http.server 5210
# abre http://localhost:5210/demo.html
```

Pon tu key real en `data-gemini-key` de `demo.html` (o pruébalo directamente en una web tuya).
Preguntas de ejemplo: "¿estáis abiertos?", "¿cuánto cuesta el chuletón?", "do you have a kids
menu?", "¿tenéis parking?" (dispara el fallback de WhatsApp).

---

## 📁 Archivos

```
chatbot-widget/
├── loader.js       inyecta widget.css + widget.js y lee la config
├── widget.js       extracción + Fase 1 + Fase 2 + estado horario + UI de chat
├── widget.css      estilos (prefijo .cbw-), claro/oscuro, móvil
├── worker.js       proxy seguro opcional (Cloudflare Worker) — la key no viaja al navegador
├── demo.html       página de prueba (restaurante)
├── demo-solar.html página de prueba (placas solares)
└── README.md       este archivo
```

## ✅ Requisitos y compatibilidad

- Navegadores modernos (Chrome, Firefox, Safari, Edge).
- No interfiere con el CSS/JS de la web (todo aislado bajo `.cbw-`, `#cbw-root`).
- Toda llamada a la API con `try/catch` y timeout de 15s; si falla, mensaje claro + WhatsApp.
