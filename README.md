# Madaleno Bot

> Bot de WhatsApp para grupos: resúmenes bajo demanda, estadísticas, GIFs con
> humor, efemérides y felicitaciones de cumpleaños. Self-hosted, un solo
> contenedor, todos los datos en CSV.

Se conecta a WhatsApp Web con una **SIM secundaria** (vinculada como
dispositivo), captura todos los mensajes y reacciones del grupo en tiempo real
y responde a comandos:

| Comando | Qué hace |
|---|---|
| `@madaleno resumen` | Resumen de las últimas 24h en 1-2 líneas |
| `@madaleno info` | Estadísticas del grupo (semana actual + pasada) |
| `@madaleno gif` | GIF animado con humor sobre lo que se habla + frase |
| `@madaleno orla` | Orla conmemorativa con las fotos del grupo |
| `@madaleno efemérides` | Qué pasó un día como hoy (desde CSV) |
| `@madaleno busca <palabras>` | Encuentra mensajes antiguos del grupo |
| `@madaleno ayuda` | Lista breve de comandos |
| `@madaleno <pregunta>` | Responde con tus datos CSV + el historial |
| — | Felicita cumpleaños cada día a las 11:30 desde un CSV |

La IA es **Google Gemini**. Todos los datos viven en **CSV** dentro de
`data/docs/`, para poder editarlos desde la interfaz de Coolify sin SSH.

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
│  groups.js     datos y admins por grupo      │
│  avisos.js     cumpleaños y eventos          │
│  ephemeris.js  efemérides                    │
│  orla.js       orla del grupo (imagen)       │
│  gemini.js     cliente de la API de Gemini   │
│  csv.js        parser CSV compartido         │
└──────────────────────────────────────────────┘
         │                        │
    data/messages.db        data/docs/*.csv
    (mensajes, reacciones)  (un CSV por grupo + comunes)
```

El GIF se renderiza reutilizando el **Chromium que ya está abierto** para
WhatsApp Web: no se lanza un segundo navegador, algo importante en un VPS
modesto. Los fotogramas se codifican con `gifenc` (JS puro, sin compilación
nativa) y se convierten a MP4 con ffmpeg, porque WhatsApp reproduce en bucle
los MP4 enviados como GIF mientras que un `.gif` suele quedarse estático.

## Requisitos

- Docker + Docker Compose (o Coolify).
- RAM modesta: un solo contenedor con Node + Chromium. ~1 GB basta.
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
   crearía un *directorio* en su lugar si no existen.

4. Levanta y escanea el QR con el WhatsApp de tu **SIM secundaria**
   (*Ajustes → Dispositivos vinculados → Vincular dispositivo*):

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

## Varios grupos

El bot puede estar en tantos grupos como quieras. Cada grupo responde con
**sus propios datos**: sus cumpleaños, sus eventos, sus efemérides, sus
datos y sus admins.

**Para añadir un grupo nuevo basta con crear un CSV.** No hay que tocar
variables de entorno ni redesplegar.

### Un CSV por grupo

**Duplica la plantilla y renómbrala con el id del grupo.** Nada más:

```
data/docs/120363011112222.csv
```

El id aparece en los logs en cuanto alguien escribe en el grupo:

```
[grupo] "Padel de los martes" id=120363011112222@g.us · autor=34699...@c.us
```

Dentro, una columna `tipo` para cada cosa:

```csv
tipo,dia,mes,anio,texto
cumple,16,5,,María García
evento,1,9,,Vuelta al cole        <- sin año = todos los años
evento,3,10,2026,Cena de empresa  <- con año = solo ese día
efemeride,16,5,2019,Nace este grupo
dato,,,,Horario de oficina: de 9 a 17h
```

Tipos: `cumple`, `evento` (o `recordatorio`), `efemeride` y `dato`.

El nombre del fichero es la **única** forma de asociarlo a un grupo. Como
el id no cambia nunca, da igual que renombren el chat.

### Ficheros comunes

Cualquier CSV cuyo nombre **no** sea un id de grupo se aplica a **todos**
los grupos. Sirve para lo que no cambia de un grupo a otro
(efemérides históricas, datos generales) y evita duplicarlo en cada
fichero.

### Admins: nada que configurar

El bot obedece a **los administradores del grupo en WhatsApp**, y a nadie
más. No hay listas de números en ningún fichero ni variable: al añadir el
bot a un grupo nuevo, quien administre ese grupo manda sobre el bot.

La lista se consulta a WhatsApp, se cachea 10 minutos y se refresca sola
cuando cambian los administradores. Si WhatsApp falla al devolverla, se
sigue usando la última conocida.

### Formato antiguo

Los CSV de la versión anterior (`cumples.csv` con `nombre,dia,mes`,
`efemerides.csv`, y cualquier otro como datos) se siguen leyendo y se
tratan como **comunes a todos los grupos**. Puedes migrarlos cuando
quieras moviendo sus filas a un fichero de grupo con la columna `tipo`.

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
- **`orla`** — compone una orla de graduación con el nombre del grupo y
  las fotos y nombres de sus miembros. No usa IA. Las fotos dependen de la
  privacidad de cada uno: quien no la tenga accesible sale con un avatar
  de iniciales. Si alguien aparece con su número (porque nunca ha escrito),
  El nombre que se muestra es, por orden: el que tengas guardado en la
  agenda del teléfono del bot, el que la persona use en WhatsApp, el que
  fijes con una fila `nombre,,,,34699111222 | María`, y por último su
  número.
  En grupos de más de `ORLA_MAX_MIEMBROS` (60) salen los más activos.
- **`busca <palabras>`** — busca en **todo** el historial guardado del
  grupo, con filtros que WhatsApp no tiene:

  ```
  @madaleno busca proveedor de:Ana
  @madaleno busca enlaces mes:junio
  @madaleno busca excel año:2025
  ```

  Insensible a mayúsculas y tildes ("cumpleaños" encuentra "cumpleanos"),
  ordena por relevancia cuando hay varios términos y muestra los enlaces
  completos. Si no hay coincidencias literales, pregunta a la IA por otras
  formas de decirlo y reintenta (así "hoja de cálculo" encuentra "os paso
  el excel"). Busca en el historial del bot, no en el móvil de cada uno:
  funciona aunque te unieras después o hayas cambiado de teléfono.
- **`ayuda`** — recuerda los comandos en dos líneas.
- **`<pregunta libre>`** — responde priorizando tus CSV, luego el historial
  del grupo, y solo al final conocimiento general (diciéndolo).

**Reacciones:** se cuentan desde que despliegas esta versión (antes no se
guardaban; no son retroactivas).

## Cumpleaños y eventos

Cada día, a partir de `BIRTHDAY_HOUR` (11:30), el bot revisa los `cumple` y
`evento` del CSV de cada grupo y avisa en el grupo correspondiente. Con la
configuración por defecto (`BIRTHDAY_CHECK_GREET=siempre`,
`BIRTHDAY_STYLE=generico`) **no consume IA**: felicita con
`🎉 ¡Feliz cumpleaños, <nombre>! 🎉` y recuerda eventos con
`📅 *Hoy:* <texto>`. Cada aviso se manda una sola vez por grupo y día.

Opcional: `BIRTHDAY_CHECK_GREET=ia` comprueba antes si alguien ya felicitó
(consume IA, no es infalible) y `BIRTHDAY_STYLE=ia` escribe felicitaciones
variadas.

### Editar los CSV desde Coolify

Los CSV están declarados como *file mounts*: en **Storages** puedes editar
su contenido desde el navegador y guardar, sin entrar por SSH. Al añadir un
grupo nuevo, crea allí el fichero (o súbelo al servidor) y el bot lo
detecta solo: los CSV se releen cuando cambian.

## Configuración (.env)

| Variable | Qué hace |
|---|---|
| `GEMINI_API_KEY` | API key de Google AI Studio |
| `GEMINI_MODEL` | Modelo (def. `gemini-3.6-flash`) |
| `BOT_TRIGGER` | Disparador (def. `@madaleno`) |
| `ADMIN_IDS` | Quién puede usar comandos (`num@c.us`, coma-sep.) |
| `QA_RATE_PER_HOUR` | Límite de comandos por admin y hora |
| `GIF_RATE_PER_HOUR` | Límite de GIFs por admin y hora |
| `BIRTHDAY_CSV` / `EPHEMERIS_CSV` | Nombres de esos CSV |
| `BIRTHDAY_HOUR` | Hora de felicitar (def. 11:30) |
| `BIRTHDAY_CHECK_GREET` | `siempre` / `ia` / `nombre` |
| `BIRTHDAY_STYLE` | `generico` / `ia` |
| `EPHEMERIS_FALLBACK_AI` | `true` para tirar de IA si el CSV no tiene nada |
| `GIF_WIDTH`, `GIF_HEIGHT`, `GIF_FRAME_MS` | Aspecto del GIF |
| `GROUP_IDS` | IDs de grupos a vigilar |
| `TIMEZONE` | Zona horaria (def. `Europe/Madrid`) |

El catálogo de modelos de Gemini cambia con frecuencia: si ves un error 404 al
llamar a la API, comprueba el modelo vigente en
https://ai.google.dev/gemini-api/docs/models y actualiza `GEMINI_MODEL`.

## Dónde se guardan los mensajes

Todo va a un SQLite dentro del volumen persistente:

```
/data/messages.db          (en el contenedor)
```

Tres tablas: `messages` (id, chat, autor, texto, fecha, from_me),
`reactions` y `avisos_enviados`. No está cifrado: quien tenga acceso al
servidor puede leer el historial completo de los grupos. Es el mismo
volumen donde vive la sesión de WhatsApp, así que trátalo como material
sensible y no lo copies fuera sin pensarlo.

Para curiosear:

```bash
docker exec -it madaleno-bot node -e "const d=require('better-sqlite3')('/data/messages.db');console.log(d.prepare('SELECT COUNT(*) n FROM messages').get())"
```

## Coste y seguridad

- Consumen Gemini: `resumen`, la parte de temas de `info`, `gif`, las
  preguntas libres y los modos `ia` de cumpleaños/efemérides. Los conteos de
  `info`, las efemérides desde CSV y los cumpleaños por defecto son gratis.
- El bot trata los CSV y los mensajes como datos, nunca como instrucciones
  (mitiga inyección de prompt); la defensa fuerte es la lista corta de admins.
- No pongas en `data/docs/` nada que no quieras que salga del servidor.
- `.env`, la sesión de WhatsApp, la base de datos y los CSV reales están en
  `.gitignore`: nunca se suben al repositorio.
