'use strict';

/**
 * Servicio de captura 24/7.
 *
 *  - Mantiene la sesión de WhatsApp Web (LocalAuth -> se guarda en disco).
 *  - Escucha 'message_create' (captura TODOS los mensajes del grupo,
 *    los hayas leído tú o no, incluidos los que envías tú).
 *  - Persiste cada mensaje en SQLite.
 *  - Expone una API HTTP mínima (solo en localhost) para consultar
 *    mensajes y enviar textos desde scripts propios si hace falta.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qa = require('./qa');
const birthdays = require('./birthdays');

// ---------- Configuración ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'messages.db');
const DOCS_DIR = path.join(DATA_DIR, 'docs');
const PORT = parseInt(process.env.CAPTURE_PORT || '3000', 10);
const GROUP_IDS = (process.env.GROUP_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Base de datos ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY,
    chat_id      TEXT NOT NULL,
    chat_name    TEXT,
    author_id    TEXT,
    author_name  TEXT,
    body         TEXT,
    type         TEXT,
    ts           INTEGER NOT NULL,        -- epoch segundos (hora del mensaje)
    captured_at  INTEGER NOT NULL         -- epoch ms (cuándo lo guardamos)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_ts ON messages (chat_id, ts);

  CREATE TABLE IF NOT EXISTS reactions (
    msg_id      TEXT NOT NULL,           -- mensaje reaccionado
    chat_id     TEXT NOT NULL,
    reactor_id  TEXT NOT NULL,           -- quién reacciona
    emoji       TEXT,                    -- emoji de la reacción ('' = retirada)
    ts          INTEGER NOT NULL,        -- epoch segundos
    PRIMARY KEY (msg_id, reactor_id)
  );
  CREATE INDEX IF NOT EXISTS idx_react_chat_ts ON reactions (chat_id, ts);
`);

const upsertReaction = db.prepare(`
  INSERT INTO reactions (msg_id, chat_id, reactor_id, emoji, ts)
  VALUES (@msg_id, @chat_id, @reactor_id, @emoji, @ts)
  ON CONFLICT(msg_id, reactor_id) DO UPDATE SET
    emoji=@emoji, ts=@ts
`);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, chat_id, chat_name, author_id, author_name, body, type, ts, captured_at)
  VALUES
    (@id, @chat_id, @chat_name, @author_id, @author_name, @body, @type, @ts, @captured_at)
`);

// Esquema de documentos (RAG) del módulo de Q&A.
qa.initSchema(db);
birthdays.initSchema(db);

// ---------- Cliente WhatsApp ----------
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, 'wweb-session') }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // Ahorro moderado de recursos, sin tocar el motor JS: limitar el
      // heap de V8 aquí puede tumbar WhatsApp Web, que es pesado.
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-accelerated-2d-canvas',
      '--mute-audio',
    ],
  },
});

client.on('qr', (qr) => {
  console.log('\n=== Escanea este QR con el WhatsApp del número secundario ===');
  console.log('(Ajustes → Dispositivos vinculados → Vincular dispositivo)\n');
  qrcode.generate(qr, { small: true });
  // Copia en disco: útil si los logs son incómodos de leer.
  // GET http://localhost:3000/qr lo devuelve como texto.
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'last-qr.txt'), qr);
  } catch (_) {}
});

client.on('authenticated', () => console.log('[wa] Autenticado, sesión guardada.'));
client.on('auth_failure', (m) => console.error('[wa] Fallo de auth:', m));

client.on('ready', () => {
  console.log('[wa] Cliente listo y escuchando.');
  if (GROUP_IDS.length === 0) {
    console.log(
      '[wa] GROUP_IDS vacío: capturando de TODOS los grupos. ' +
        'Mira los logs para ver el id de tu grupo y fíjalo en .env.'
    );
  } else {
    console.log('[wa] Capturando solo los grupos:', GROUP_IDS.join(', '));
  }
});

// 'message_create' se dispara con cualquier mensaje del chat
// (entrantes y propios), sin necesidad de que tú lo abras/leas.
client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat();
    if (!chat.isGroup) return;

    const chatId = chat.id._serialized;

    // Log de descubrimiento: ayuda a encontrar el id del grupo.
    if (GROUP_IDS.length === 0) {
      console.log(`[grupo] "${chat.name}"  id=${chatId}`);
    }
    if (GROUP_IDS.length > 0 && !GROUP_IDS.includes(chatId)) return;

    let authorName = null;
    try {
      const contact = await msg.getContact();
      authorName = contact.pushname || contact.name || contact.number || null;
    } catch (_) {
      /* contacto no disponible */
    }

    insertStmt.run({
      id: msg.id._serialized,
      chat_id: chatId,
      chat_name: chat.name || null,
      author_id: msg.author || msg.from || null,
      author_name: authorName,
      body: msg.body || '',
      type: msg.type || 'chat',
      ts: msg.timestamp || Math.floor(Date.now() / 1000),
      captured_at: Date.now(),
    });

    // ---- Q&A: ¿es una pregunta dirigida al bot por un admin? ----
    const reply = await qa.handleIncoming(db, {
      body: msg.body || '',
      authorId: msg.author || msg.from || null,
      chatId,
      docsDir: DOCS_DIR,
      // El GIF se renderiza con el Chromium que ya usa WhatsApp Web.
      getBrowser: () => client.pupBrowser,
    });

    if (typeof reply === 'string' && reply) {
      await client.sendMessage(chatId, reply);
    } else if (reply && reply.media) {
      // GIF/MP4 generado por @madaleno gif
      const m = reply.media;
      const media = MessageMedia.fromFilePath(m.path);
      await client.sendMessage(chatId, media, {
        caption: m.caption || undefined,
        // WhatsApp reproduce en bucle los MP4 enviados como "gif"
        sendVideoAsGif: !!m.isVideo,
      });
      fs.unlink(m.path, () => {});          // limpia el temporal
      if (m.path.endsWith('.mp4')) {
        fs.unlink(m.path.replace(/\.mp4$/, '.gif'), () => {});
      }
    }
  } catch (err) {
    console.error('[capture] Error guardando mensaje:', err.message);
  }
});

// Captura de reacciones (👍❤️😂...). WhatsApp emite 'message_reaction'
// tanto al poner como al quitar una reacción (emoji vacío = retirada).
client.on('message_reaction', (reaction) => {
  try {
    const chatId =
      (reaction.id && reaction.id.remote) || reaction.msgId?.remote || null;
    if (!chatId) return;
    if (GROUP_IDS.length > 0 && !GROUP_IDS.includes(chatId)) return;

    upsertReaction.run({
      msg_id: reaction.msgId?._serialized || String(reaction.msgId),
      chat_id: chatId,
      reactor_id: reaction.senderId || 'desconocido',
      emoji: reaction.reaction || '', // '' cuando se retira
      ts: reaction.timestamp || Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    console.error('[capture] Error guardando reacción:', err.message);
  }
});

// ---------- Arranque robusto ----------
// client.initialize() devuelve una promesa: si se llama "a pelo" y falla
// (Chromium matado por falta de memoria, "Target closed", timeout de
// navegación...), Node mata el proceso por unhandled rejection y el
// contenedor entra en bucle de reinicio. Aquí se reintenta con espera
// creciente y el proceso sigue vivo.
let arrancando = false;
let intentos = 0;

/**
 * Borra los candados que Chromium deja en el perfil cuando el contenedor
 * muere de golpe (SIGKILL, OOM, reinicio del servidor...).
 *
 * Sin esto, el siguiente arranque falla con "The profile appears to be in
 * use by another Chromium process ... on another computer", porque el
 * candado apunta al nombre de máquina del contenedor anterior. Como cada
 * contenedor tiene un hostname distinto, el bloqueo es permanente y solo
 * se resuelve a mano. Son ficheros de bloqueo, no datos de sesión: es
 * seguro borrarlos cuando no hay ningún Chromium vivo, que es justo el
 * caso al arrancar el proceso.
 */
function limpiarCandadosChromium() {
  const base = path.join(DATA_DIR, 'wweb-session');
  if (!fs.existsSync(base)) return;

  const nombres = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  let borrados = 0;

  const limpiarEn = (dir) => {
    for (const n of nombres) {
      const f = path.join(dir, n);
      try {
        // lstat: SingletonLock es un enlace simbólico "roto" a propósito,
        // así que existsSync() puede devolver false. Hay que mirar el
        // enlace en sí, no su destino.
        fs.lstatSync(f);
        fs.unlinkSync(f);
        borrados++;
      } catch (_) {
        /* no existe: nada que hacer */
      }
    }
  };

  limpiarEn(base);
  try {
    for (const entrada of fs.readdirSync(base, { withFileTypes: true })) {
      if (entrada.isDirectory()) limpiarEn(path.join(base, entrada.name));
    }
  } catch (e) {
    console.error('[wa] No pude revisar el perfil:', e.message);
  }

  if (borrados > 0) {
    console.log(`[wa] Candados de Chromium huérfanos eliminados: ${borrados}`);
  }
}

async function arrancarWhatsApp() {
  if (arrancando) return;
  arrancando = true;
  try {
    limpiarCandadosChromium();
    console.log(`[wa] Inicializando cliente (intento ${intentos + 1})...`);
    await client.initialize();
    intentos = 0;
    console.log('[wa] Inicialización completada.');
  } catch (err) {
    intentos++;
    const espera = Math.min(60, 5 * intentos); // 5s, 10s, ... máx 60s
    console.error(
      `[wa] Fallo al inicializar (${err.message}). ` +
        `Reintento en ${espera}s.`
    );
    setTimeout(() => {
      arrancando = false;
      arrancarWhatsApp();
    }, espera * 1000);
    return;
  }
  arrancando = false;
}

arrancarWhatsApp();

// Si WhatsApp desconecta la sesión, reintenta en vez de quedarse muerto.
client.on('disconnected', (motivo) => {
  console.error('[wa] Desconectado:', motivo, '- reintentando en 15s');
  setTimeout(() => {
    arrancando = false;
    arrancarWhatsApp();
  }, 15000);
});

// Red de seguridad: un error asíncrono suelto no debe tumbar el bot.
process.on('unhandledRejection', (err) => {
  console.error('[sys] Promesa rechazada sin gestionar:', err && err.message);
});
process.on('uncaughtException', (err) => {
  console.error('[sys] Excepción no capturada:', err && err.stack);
});

// ---- Ingesta de documentos: al estar listo y luego cada 10 min ----
client.on('ready', () => {
  qa.ingestDocs(db, DOCS_DIR).catch((e) =>
    console.error('[qa] Ingesta inicial falló:', e.message)
  );
  setInterval(() => {
    qa.ingestDocs(db, DOCS_DIR).catch((e) =>
      console.error('[qa] Reingesta falló:', e.message)
    );
  }, 10 * 60 * 1000);

  // ---- Cumpleaños: revisa cada 15 min (el módulo solo actúa pasada
  //      la hora configurada, p.ej. 11:30, y solo una vez por persona/año).
  const runBirthdayCheck = async () => {
    if (GROUP_IDS.length === 0) return; // necesita saber a qué grupo escribir
    for (const gid of GROUP_IDS) {
      try {
        const msgs = await birthdays.checkBirthdays(db, gid, DOCS_DIR);
        for (const text of msgs) {
          await client.sendMessage(gid, text);
        }
      } catch (e) {
        console.error('[bday] Error en chequeo:', e.message);
      }
    }
  };
  runBirthdayCheck();
  setInterval(runBirthdayCheck, 15 * 60 * 1000);
});

// ---------- API HTTP ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

// Último QR emitido (texto plano). Útil si los logs son incómodos.
app.get('/qr', (_req, res) => {
  try {
    res.type('text/plain').send(
      fs.readFileSync(path.join(DATA_DIR, 'last-qr.txt'), 'utf8')
    );
  } catch (e) {
    res.status(404).send('No hay QR pendiente (¿ya está vinculado?)');
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, state: client.info ? 'ready' : 'starting' });
});

// Lista de grupos conocidos (para descubrir ids cómodamente).
app.get('/groups', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT chat_id, chat_name, COUNT(*) AS msgs, MAX(ts) AS last_ts
         FROM messages GROUP BY chat_id ORDER BY last_ts DESC`
    )
    .all();
  res.json(rows);
});

/**
 * Mensajes en una ventana temporal.
 *   GET /messages?chat_id=...&since=<epoch_s>&until=<epoch_s>
 * Si no se pasa 'since', usa las últimas 24h.
 */
app.get('/messages', (req, res) => {
  const nowS = Math.floor(Date.now() / 1000);
  const since = parseInt(req.query.since || nowS - 86400, 10);
  const until = parseInt(req.query.until || nowS, 10);
  const chatId = req.query.chat_id;

  let sql = `SELECT author_name, body, ts, type FROM messages
             WHERE ts >= ? AND ts <= ?`;
  const params = [since, until];
  if (chatId) {
    sql += ' AND chat_id = ?';
    params.push(chatId);
  }
  sql += ' ORDER BY ts ASC';

  const rows = db.prepare(sql).all(...params);
  res.json({ count: rows.length, since, until, messages: rows });
});

/**
 * Enviar un mensaje al grupo desde fuera (uso opcional/manual).
 *   POST /send  { "to": "<chat_id|self>", "text": "..." }
 * 'self' = enviártelo a ti mismo (chat contigo).
 */
app.post('/send', async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'falta text' });

    let target = to;
    if (!target || target === 'self') {
      target = client.info.wid._serialized; // tu propio chat
    }
    await client.sendMessage(target, text);
    res.json({ ok: true, to: target });
  } catch (err) {
    console.error('[send] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`[http] API de captura en :${PORT}`));

// Cierre limpio
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n[sys] ${sig} recibido, cerrando...`);
    // Docker concede ~10s antes del SIGKILL. Si Chromium tarda más en
    // cerrar, salimos igualmente pero dejando el perfil desbloqueado.
    const salidaForzosa = setTimeout(() => {
      console.error('[sys] Cierre lento, forzando salida.');
      try {
        limpiarCandadosChromium();
      } catch (_) {}
      process.exit(0);
    }, 8000);

    try {
      await client.destroy();
    } catch (_) {}
    try {
      limpiarCandadosChromium();
      db.close();
    } catch (_) {}
    clearTimeout(salidaForzosa);
    process.exit(0);
  });
}
