# Madaleno Bot

Bot de WhatsApp para grupos: resúmenes en texto y GIF, estadísticas,
calendario con avisos, efemérides, orla del grupo y respuestas sobre el
historial del chat y tus propios datos.

## ⚠️ Antes de nada

Usa [whatsapp-web.js](https://wwebjs.dev/), una librería **no oficial** que
vincula un dispositivo más. **Incumple los términos de WhatsApp y el número
puede ser baneado: usa una SIM secundaria, nunca tu número personal.**

Los mensajes y tus datos se envían a Google Gemini para generar respuestas.
Los miembros del grupo deberían saberlo.

## Requisitos

- Docker y Docker Compose. La imagen se construye en dos fases: los
  compiladores del módulo de cifrado se quedan fuera de la imagen final.
- Una API key de Gemini: https://aistudio.google.com/apikey
- ~1 GB de RAM libre.

## Instalación

```bash
git clone https://github.com/<TU_USUARIO>/madaleno-bot.git
cd madaleno-bot
cp .env.example .env          # pega tu GEMINI_API_KEY
docker compose up -d
docker compose logs -f capture    # escanea el QR con la SIM secundaria
```

Escribe algo en el grupo y mira los logs:

```
[grupo] "Padel" id=120363011112222@g.us · autor=34699111222@c.us
```

Con ese id, crea el CSV del grupo (ver abajo). No hace falta configurar
admins: el bot obedece a los administradores del grupo en WhatsApp.

## Comandos

En el grupo, escribiendo `@madaleno <comando>`:

| Comando | Quién | Qué hace |
|---|---|---|
| `eventos` | todos | Qué viene: próximos 30 días |
| `efemérides` | todos | Qué pasó un día como hoy |
| `ayuda` | todos | Lista de comandos |
| `resumen` | admins | Las últimas 24 h en 2 líneas |
| `info` | admins | Estadísticas del grupo + cómo está configurado |
| `gif` | admins | Animación con humor de lo que se habla |
| `orla` | admins | Orla con las fotos del grupo |
| `busca <texto>` | admins | Busca en todo el historial |
| `calendario` | admins | Enlace privado para editar el calendario |
| `añade 3/10 Cena` | admins | Apunta un evento (`borra 2` lo quita) |
| `admin 34600...` | admins | Gestiona quién manda al bot |
| `<pregunta>` | admins | Responde con tus datos, el calendario y el historial |

Por privado, cualquier miembro:

| Comando | Qué hace |
|---|---|
| `miresumen` | Solo lo que le afecta a él (`semana` para 7 días) |
| `web` | Enlace para editar el calendario (si es admin) |

## Datos: un CSV por grupo

En `data/docs/`, un fichero por grupo **con el id como nombre**
(`120363011112222.csv`). Cualquier CSV con otro nombre (`generico.csv`) se
aplica a todos los grupos.

```csv
tipo,dia,mes,anio,texto,repite,aviso
cumple,16,5,,María García,anual,si
evento,1,9,,Vuelta al cole,anual,si
evento,3,10,2026,Cena de empresa,unavez,si
efemeride,16,5,2019,Nace este grupo,anual,no
dato,,,,Horario de oficina: de 9 a 17h
nombre,,,,34699111222 | María García
```

| Tipo | Para qué |
|---|---|
| `cumple` | Cumpleaños |
| `evento` | Evento o recordatorio |
| `efemeride` | Se consulta con `efemérides` |
| `dato` | Información para responder preguntas |
| `nombre` | Nombre a mostrar en la orla (`telefono \| nombre`) |

- `repite`: `anual` (todos los años) o `unavez` (solo esa fecha).
- `aviso`: `si` para que el bot lo anuncie en el grupo ese día.

Los CSV se releen al cambiar; no hay que reiniciar.

Todo lo del calendario es consultable: sale en `eventos` (lo que viene),
en `efemérides` (lo de un día como hoy) y en las preguntas libres
("¿cuándo es el cumple de María?").

## Calendario

Los admins lo gestionan desde WhatsApp:

```
@madaleno añade 3/10 Cena de empresa
@madaleno añade cumple 16/5 María
@madaleno añade 1/9 Vuelta al cole sin aviso
@madaleno borra 2
```

Fechas: `16/5`, `16/5/2026`, `16 de mayo`, `hoy`, `mañana`.
Modificadores: `sin aviso`, `con aviso`, `cada año`, `una vez`.

### Interfaz web

Para editar desde el móvil, `@madaleno calendario` pide el enlace y el bot
lo manda por privado. Requiere publicar el puerto `WEB_PORT` con HTTPS y
definir `WEB_BASE_URL`.

**El enlace es la credencial**: la web no comprueba quién pulsa, así que
quien lo tenga puede editar ese calendario hasta que caduque
(`WEB_TOKEN_HORAS`). Por eso se entrega en privado. Con
`WEB_LINK_EN_GRUPO=true` se publica en el grupo, avisando y con caducidad
corta; los cambios se anuncian siempre en el grupo con el nombre de quien
pidió el enlace.

## Avisos diarios

A partir de `BIRTHDAY_HOUR` (11:30), el bot anuncia en cada grupo los
`cumple` y `evento` del día con `aviso=si`. Una sola vez por grupo y día.

## Configuración (.env)

| Variable | Qué hace |
|---|---|
| `GEMINI_API_KEY` | API key de Gemini |
| `GEMINI_MODEL` | Modelo (def. `gemini-3.6-flash`) |
| `BOT_TRIGGER` | Disparador (def. `@madaleno`) |
| `GROUP_IDS` | Lista blanca de grupos. Vacío = todos |
| `BIRTHDAY_HOUR` | Hora de los avisos (def. 11:30) |
| `WEB_PORT`, `WEB_BASE_URL` | Interfaz web del calendario |
| `WEB_TOKEN_HORAS` | Caducidad de los enlaces (def. 24) |
| `WEB_LINK_EN_GRUPO` | Publicar el enlace en el grupo (def. false) |
| `QA_RATE_PER_HOUR`, `GIF_RATE_PER_HOUR` | Topes por admin y hora |
| `EPHEMERIS_FALLBACK_AI` | Usar IA si el CSV no tiene efeméride |
| `TIMEZONE` | Zona horaria (def. `Europe/Madrid`) |

## Administradores

Normalmente **no hay que configurar nada**: el bot lee del almacén interno
de WhatsApp Web quiénes administran el grupo y los registra solos.

Esa lectura se hace con código propio y acotado, no con `getChatById` de
la librería, que se rompe con cada cambio de WhatsApp Web
([bug abierto](https://github.com/wwebjs/whatsapp-web.js/issues/201838)).
Si aun así no lo consigue, el bot lleva **su propio registro** y el primer
administrador se da de alta **por privado** (nunca en el grupo: el código
quedaría a la vista de todos y serviría para otros grupos):

```
(chat privado con el bot)
@madaleno alta CODIGO        → si compartís un solo grupo
@madaleno alta CODIGO 2      → si compartís varios, elige de la lista
```

El código es el de `ADMIN_SETUP_CODE`; si lo dejas vacío, el bot genera
uno al arrancar y lo escribe en los logs. Solo funciona en grupos que aún
no tengan administradores, y el alta es **por grupo**: darse de alta en
uno no da permisos en los demás.

Si alguien escribe `alta` en el grupo, el bot no acepta el código ahí:
responde con un enlace para continuar en privado.

El código **solo funciona mientras el grupo no tenga ningún admin**: en
cuanto hay uno, deja de servir, así que aunque se filtre no vale para
colarse. A partir de ahí, los administradores se gestionan entre ellos:

```
@madaleno admin 34600111222      dar permisos
@madaleno admin                  (respondiendo a alguien) darle permisos
@madaleno admin                  lista de administradores
@madaleno admin quita 34600...   quitar permisos
```

Si WhatsApp sí responde, sus administradores se incorporan solos al
registro y quedan guardados.

## Dónde se guarda todo

SQLite en `/data/messages.db` (mensajes, reacciones, avisos enviados) y los
CSV en `/data/docs/`. Ahí vive también la sesión de WhatsApp.

### Cifrado (opcional)

Con `DB_KEY` en el `.env`, la base se guarda cifrada con AES-256. Si ya
existía en claro, se migra sola al arrancar y deja una copia
`messages.db.enclaro.bak` que debes borrar tú tras comprobar que va bien.

```bash
openssl rand -hex 32     # genera la clave
```

Qué protege y qué no:

- ✅ Copias de seguridad, discos o volúmenes robados: sin la clave son ruido.
- ❌ Alguien con acceso al servidor: la clave está en el entorno del
  contenedor, a su alcance.

Para **cambiar la clave**: pon la anterior en `DB_KEY_ANTERIOR`, la nueva
en `DB_KEY` y arranca. Se rota sola y deja copia; después quita
`DB_KEY_ANTERIOR`.

**Si pierdes `DB_KEY` pierdes el historial.** Guárdala fuera del servidor.
La sesión de WhatsApp (`/data/wweb-session`) no se cifra: protégela con
permisos del sistema.

## Coste

Consumen Gemini: `resumen`, los temas de `info`, `gif`, las preguntas
libres y la búsqueda por aproximación. `eventos`, `efemérides`, `busca`,
`orla` y los avisos diarios son gratis.
