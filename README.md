# Madaleno Bot

<img src="data/madaleno-bot-small.png" alt="Madaleno Bot" width="96">

Bot de WhatsApp para grupos: resúmenes en texto y GIF, estadísticas,
calendario con avisos automáticos, orla del grupo y respuestas sobre el
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

En el grupo, escribiendo `@madaleno <comando>`. Accesibles a cualquier
miembro, sea o no administrador:

| Comando                | Qué hace                                       |
| ---------------------- | ---------------------------------------------- |
| `resumen`              | Las últimas 24 h en 2 líneas                   |
| `info`                 | Estadísticas del grupo + cómo está configurado |
| `gif`                  | Animación con humor de lo que se habla         |
| `orla`                 | Orla con las fotos del grupo                   |
| `ayuda` / `help` / `?` | Lista de comandos                              |

**chat privado** con el bot:

| Comando     | Qué hace                                          |
| ----------- | ------------------------------------------------- |
| `miresumen` | Solo lo que te afecta a ti (`semana` para 7 días) |

Si compartís varios grupos, pregunta de cuál lo quieres y basta con
responder el número. Todos los mensajes del bot terminan con `🫴🏻🪙`. |

## Datos: un CSV por grupo

En `data/docs/`, un fichero por grupo **con el id como nombre**
(`120363011112222.csv`). Cualquier CSV con otro nombre (`generico.csv`) se
aplica a todos los grupos.

Los CSV se releen al cambiar; no hay que reiniciar.

## Configuración (.env)

| Variable                                | Qué hace                         |
| --------------------------------------- | -------------------------------- |
| `GEMINI_API_KEY`                        | API key de Gemini                |
| `GEMINI_MODEL`                          | Modelo (def. `gemini-3.6-flash`) |
| `BOT_TRIGGER`                           | Disparador (def. `@madaleno`)    |
| `QA_RATE_PER_HOUR`, `GIF_RATE_PER_HOUR` | Topes por persona y hora         |

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

Consumen Gemini: `resumen`, los temas de `info` y `gif`. `orla` y los
avisos diarios son gratis.
