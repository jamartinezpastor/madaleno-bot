# Madaleno Bot

Bot de WhatsApp para grupos: resúmenes en texto y .GIF bajo demanda, estadísticas, efemérides y recordatorio de eventos. Self-hosted en un contenedor y con los datos persistidos en CSV.

Se conecta a WhatsApp Web con una **SIM secundaria** (vinculada como
dispositivo), captura todos los mensajes y reacciones del grupo en tiempo real
y responde a comandos:

| Comando                | Qué hace                                            |
| ---------------------- | --------------------------------------------------- |
| `@madaleno resumen`    | Resumen de las últimas 24h en 1-2 líneas            |
| `@madaleno info`       | Estadísticas del grupo (semana actual + pasada)     |
| `@madaleno gif`        | GIF animado con humor sobre lo que se habla + frase |
| `@madaleno efemérides` | Qué pasó un día como hoy (desde CSV)                |
| `@madaleno <pregunta>` | Responde con tus datos CSV + el historial           |
| —                      | Recordatorio de eventos/Cumpleaños (desde CSV)      |

La API que se utiliza para IA es **Google Gemini**. Todos los datos viven en **CSV** dentro de
`data/docs/`, para poder editarlos desde cualquier editor de texto facilmente.

## ⚠️ Lee esto antes de nada

WhatsApp **no tiene API oficial para leer grupos**. Esto usa
[whatsapp-web.js](https://wwebjs.dev/), una librería **no oficial** que se
vincula como un dispositivo más.

- **Viola los Términos de Servicio de WhatsApp.** El número puede ser baneado:
  por eso se usa una **SIM secundaria**, nunca el número personal.
- Puede romperse si WhatsApp cambia su protocolo (suele arreglarse en días
  actualizando la librería).
- **Privacidad:** el contenido de los mensajes y de los CSV se envía a Google
  Gemini para generar respuestas. Los miembros del grupo deberían saber que la
  conversación se está procesando (consideración GDPR si hay terceros).

## Arquitectura

```
┌──────────────────────────────────────────────┐
│  capture/ (Node.js, 24/7, un contenedor)     │
│                                              │
│  index.js      sesión WhatsApp + SQLite      │
│                (mensajes y reacciones)       │
│  qa.js         comandos del grupo            │
│  gifmaker.js   GIF (Chromium + gifenc)       │
│  ephemeris.js  efemérides desde CSV          │
│  birthdays.js  felicitaciones desde CSV      │
│  gemini.js     cliente de la API de Gemini   │
│  csv.js        parser CSV compartido         │
└──────────────────────────────────────────────┘
         │                        │
    data/messages.db        data/docs/*.csv
    (mensajes, reacciones)  (tus datos, editables)
```

El GIF se renderiza reutilizando el **Chromium que ya está abierto** para
WhatsApp Web. Los fotogramas se codifican con `gifenc` (JS puro, sin compilación
nativa), se convierten a MP4 con ffmpeg y después se envian como GIF para que se reproduzcan en bucle.

## Requisitos

- Docker + Docker Compose.
- RAM: un contenedor con Node + Chromium. ~1 GB basta.
- Salida HTTPS hacia `generativelanguage.googleapis.com`.

## Puesta en marcha

```bash
git clone https://github.com/<TU_USUARIO>/madaleno-bot.git
cd madaleno-bot
```

1. Crea una API key en https://aistudio.google.com/apikey

2. `cp .env.example .env` y pega tu `GEMINI_API_KEY`.
   (`.env` está en `.gitignore`: nunca se sube al repo.)

3. Crea tus CSV a partir de las plantillas:

   ```bash
   cd data/docs
   cp conocimiento.csv.example conocimiento.csv
   cp cumples.csv.example      cumples.csv
   cp efemerides.csv.example   efemerides.csv
   cd ../..
   ```

   Los tres ficheros deben existir antes de levantar el contenedor: Docker
   crearía un _directorio_ en su lugar si no existen.

4. Levanta y escanea el QR con el WhatsApp de tu **SIM secundaria**
   (_Ajustes → Dispositivos vinculados → Vincular dispositivo_):

   ```bash
   docker compose up -d
   docker compose logs -f capture
   ```

5. Escribe algo en el grupo y mira los logs: verás el `id` del grupo y tu
   `author_id` (formato `34699111222@c.us`). Ponlos en `.env`:

   ```
   GROUP_IDS=1203630xxxxxxxxx@g.us
   ADMIN_IDS=34699111222@c.us
   ```

6. `docker compose restart capture` y listo.

> El puerto 3000 se publica solo en `127.0.0.1`. Para verlo desde fuera, túnel
> SSH.

## Ficheros CSV con la persistencia

Todo el contenido del bot son CSV en `data/docs/`:

| Fichero            | Para qué            | Columnas                                      |
| ------------------ | ------------------- | --------------------------------------------- |
| `cumples.csv`      | Cumpleaños          | `nombre,dia,mes` (o `nombre,fecha`)           |
| `efemerides.csv`   | Efemérides          | `dia,mes,anio,acontecimiento`                 |
| `conocimiento.csv` | Responder preguntas | libres (`tema,dato`, `pregunta,respuesta`...) |

Cualquier **otro** `.csv` que dejes en `data/docs/` se suma automáticamente al
conocimiento para las preguntas. El parser admite comillas (`"texto, con
comas"`), separador `,` o `;` (Excel español), cabecera opcional y líneas de
comentario que empiecen por `#`.

Los CSV se releen solos cuando cambian: **no hace falta reiniciar** tras
editarlos (los cumpleaños y efemérides se leen en cada consulta; el
conocimiento detecta el cambio por fecha de modificación).

### Editarlos con un PaaS (Coolify)

En `docker-compose.yml` los tres CSV están declarados como _montajes de
fichero_ individuales. Por ejemplo, Coolify los muestra en:

**Tu recurso → Storages → (el montaje del CSV) → editar contenido → Save**

Así puedes añadir o quitar cumpleaños, efemérides o datos desde el navegador,
sin entrar por SSH. Notas prácticas:

- Coolify aplica los cambios de storages al **redesplegar/reiniciar** el
  recurso; el bot releerá el CSV en la siguiente consulta.
- Si Coolify muestra un montaje como _directorio_ en vez de fichero, usa el
  botón **Convert to File** (ocurre cuando el fichero no existía al desplegar).
- Alternativa siempre válida: editar los ficheros en el host, en la ruta del
  proyecto.

## Comandos

Solo responden a los IDs de `ADMIN_IDS`; a cualquier otro miembro el bot lo
ignora **en silencio** (no revela que existe).

- **`resumen`** — resume las últimas 24h en 1-2 líneas.
- **`info`** — mensajes totales, media de longitud, emoji más usado, top 5 de
  quien más escribe, quién recibe más reacciones, quién más reacciona, hora
  más activa, temas y un dato curioso. Los conteos son exactos (salen de
  SQLite); temas y curiosidad los redacta Gemini.
- **`gif`** (o `animación`) — analiza los últimos 3 días, monta un GIF de
  ~4-5 viñetas con humor irónico y lo envía con una frase corta. Tarda unos
  segundos y tiene su propio límite (`GIF_RATE_PER_HOUR`, por defecto 5/hora)
  porque es lo más costoso.
- **`efemérides`** / **`efemerides`** — acontecimientos del CSV que coinciden
  en día y mes, ordenados por año. Es determinista y gratis. Si el día no
  tiene nada y activas `EPHEMERIS_FALLBACK_AI=true`, lo pregunta a Gemini
  (avisando de que puede equivocarse).
- **`<pregunta libre>`** — responde priorizando tus CSV, luego el historial
  del grupo, y solo al final conocimiento general (diciéndolo).

## Cumpleaños

Con la configuración por defecto (`BIRTHDAY_CHECK_GREET=siempre`,
`BIRTHDAY_STYLE=generico`) el bot felicita cada día a las 11:30 con
`🎉 ¡Feliz cumpleaños, <nombre>! 🎉`, **sin consumir IA**. Solo felicita una
vez por persona y año. Requiere `GROUP_IDS` definido.

Opcional: `BIRTHDAY_CHECK_GREET=ia` comprueba antes si alguien ya felicitó
(consume Gemini, no es infalible) y `BIRTHDAY_STYLE=ia` escribe un texto
variado cada vez.

## Configuración (.env)

| Variable                                  | Qué hace                                          |
| ----------------------------------------- | ------------------------------------------------- |
| `GEMINI_API_KEY`                          | API key de Google AI Studio                       |
| `GEMINI_MODEL`                            | Modelo (def. `gemini-3.6-flash`)                  |
| `BOT_TRIGGER`                             | Disparador (def. `@madaleno`)                     |
| `ADMIN_IDS`                               | Quién puede usar comandos (`num@c.us`, coma-sep.) |
| `QA_RATE_PER_HOUR`                        | Límite de comandos por admin y hora               |
| `GIF_RATE_PER_HOUR`                       | Límite de GIFs por admin y hora                   |
| `BIRTHDAY_CSV` / `EPHEMERIS_CSV`          | Nombres de esos CSV                               |
| `BIRTHDAY_HOUR`                           | Hora de felicitar (def. 11:30)                    |
| `BIRTHDAY_CHECK_GREET`                    | `siempre` / `ia` / `nombre`                       |
| `BIRTHDAY_STYLE`                          | `generico` / `ia`                                 |
| `EPHEMERIS_FALLBACK_AI`                   | `true` para tirar de IA si el CSV no tiene nada   |
| `GIF_WIDTH`, `GIF_HEIGHT`, `GIF_FRAME_MS` | Aspecto del GIF                                   |
| `GROUP_IDS`                               | IDs de grupos a vigilar                           |
| `TIMEZONE`                                | Zona horaria (def. `Europe/Madrid`)               |

El catálogo de modelos de Gemini cambia con frecuencia: si ves un error 404 al
llamar a la API, comprueba el modelo vigente en
https://ai.google.dev/gemini-api/docs/models y actualiza `GEMINI_MODEL`.

## Coste y seguridad

- Consumen Gemini: `resumen`, la parte de temas de `info`, `gif`, las
  preguntas libres y los modos `ia` de cumpleaños/efemérides. Los conteos de
  `info`, las efemérides desde CSV y los cumpleaños por defecto son gratis.
- El bot trata los CSV y los mensajes como datos, nunca como instrucciones
  (mitiga inyección de prompt); la defensa fuerte es la lista corta de admins.
- No pongas en `data/docs/` nada que no quieras que salga del servidor.
- `.env`, la sesión de WhatsApp, la base de datos y los CSV reales están en
  `.gitignore`: nunca se suben al repositorio.
