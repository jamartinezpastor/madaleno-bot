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
const abrirBaseDatos = require('./db').abrir;
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qa = require('./qa');
const avisos = require('./avisos');
const groups = require('./groups');
const util = require('./util');
const personal = require('./personal');
const tokens = require('./token');
const web = require('./web');

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
const db = abrirBaseDatos(DB_PATH);
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
    captured_at  INTEGER NOT NULL,        -- epoch ms (cuándo lo guardamos)
    from_me      INTEGER NOT NULL DEFAULT 0, -- 1 = lo envió el propio bot
    body_norm    TEXT                        -- body en minúsculas y sin tildes
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

// Migración suave: añade columnas nuevas a bases de datos ya creadas.
{
  const cols = db
    .prepare('PRAGMA table_info(messages)')
    .all()
    .map((c) => c.name);
  if (!cols.includes('from_me')) {
    db.exec('ALTER TABLE messages ADD COLUMN from_me INTEGER NOT NULL DEFAULT 0');
    console.log('[db] Migración: columna from_me añadida.');
  }
}

// Migración: body_norm permite filtrar dentro de SQLite (rápido) en vez
// de traerse decenas de miles de mensajes a memoria para normalizarlos.
try {
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('body_norm')) {
    db.exec('ALTER TABLE messages ADD COLUMN body_norm TEXT');
    console.log('[db] Migración: columna body_norm añadida.');
  }
  const pendientes = db
    .prepare("SELECT COUNT(*) n FROM messages WHERE body_norm IS NULL AND body != ''")
    .get().n;
  if (pendientes > 0) {
    console.log(`[db] Normalizando ${pendientes} mensajes antiguos...`);
    const leer = db.prepare(
      "SELECT id, body FROM messages WHERE body_norm IS NULL AND body != '' LIMIT 5000"
    );
    const escribir = db.prepare('UPDATE messages SET body_norm = ? WHERE id = ?');
    let restantes = pendientes;
    while (restantes > 0) {
      const lote = leer.all();
      if (lote.length === 0) break;
      db.transaction(() => {
        for (const f of lote) escribir.run(util.norm(f.body), f.id);
      })();
      restantes -= lote.length;
    }
    console.log('[db] Normalización completada.');
  }
} catch (e) {
  console.error('[db] Migración body_norm:', e.message);
}

// Retención opcional: sin esto la base de datos crece indefinidamente.
// 0 = guardar todo (por defecto).
const RETENCION_DIAS = parseInt(process.env.RETENCION_DIAS || '0', 10);
function purgarAntiguos() {
  if (!RETENCION_DIAS) return;
  try {
    const corte = Math.floor(Date.now() / 1000) - RETENCION_DIAS * 86400;
    const r = db.prepare('DELETE FROM messages WHERE ts < ?').run(corte);
    if (r.changes > 0) {
      db.prepare('DELETE FROM reactions WHERE ts < ?').run(corte);
      console.log(`[db] Purgados ${r.changes} mensajes de más de ${RETENCION_DIAS} días.`);
    }
  } catch (e) {
    console.error('[db] Purga:', e.message);
  }
}
purgarAntiguos();
setInterval(purgarAntiguos, 24 * 3600 * 1000);

// Índice para las búsquedas y los recuentos por chat.
try {
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_msg_busqueda ON messages (chat_id, from_me, ts)'
  );
} catch (_) {}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
    (id, chat_id, chat_name, author_id, author_name, body, type, ts,
     captured_at, from_me)
  VALUES
    (@id, @chat_id, @chat_name, @author_id, @author_name, @body, @type, @ts,
     @captured_at, @from_me)
`);

// Esquema de documentos (RAG) del módulo de Q&A.
qa.initSchema(db);
avisos.initSchema(db);
personal.initSchema(db);

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

// Caché de nombres de grupo: getChat() es una llamada al WhatsApp Web
// interno y puede fallar (errores minificados tipo "r"). Solo se intenta
// una vez por chat y su fallo nunca bloquea la captura del mensaje.
// ---- Datos para la orla ----
// Reúne miembros del grupo con su nombre y su foto de perfil. Las fotos
// dependen de la privacidad de cada usuario: si no hay, el módulo de la
// orla dibuja un avatar con las iniciales.
const MAX_ORLA = parseInt(process.env.ORLA_MAX_MIEMBROS || '60', 10);

function nombreDesdeBD(authorId) {
  try {
    const row = db
      .prepare(
        `SELECT author_name FROM messages
          WHERE author_id = ? AND author_name IS NOT NULL AND author_name != ''
          ORDER BY ts DESC LIMIT 1`
      )
      .get(authorId);
    return row ? row.author_name : null;
  } catch (_) {
    return null;
  }
}

function mensajesPorAutor(chatId) {
  const cuenta = new Map();
  try {
    const filas = db
      .prepare(
        `SELECT author_id, COUNT(*) AS n FROM messages
          WHERE chat_id = ? AND from_me = 0 GROUP BY author_id`
      )
      .all(chatId);
    for (const f of filas) cuenta.set(f.author_id, f.n);
  } catch (_) {}
  return cuenta;
}

async function datosOrla(chatId, sobrescrituras = {}) {
  const chat = await client.getChatById(chatId);
  if (!chat || !chat.isGroup) throw new Error('Esto no es un grupo');

  const yo = client.info && client.info.wid && client.info.wid._serialized;
  let participantes = (chat.participants || []).filter(
    (p) => p.id && p.id._serialized !== yo // el bot no sale en su propia orla
  );

  // En grupos muy grandes, los más participativos.
  let recortado = false;
  if (participantes.length > MAX_ORLA) {
    const cuenta = mensajesPorAutor(chatId);
    participantes = participantes
      .sort(
        (a, b) =>
          (cuenta.get(b.id._serialized) || 0) - (cuenta.get(a.id._serialized) || 0)
      )
      .slice(0, MAX_ORLA);
    recortado = true;
  }

  const miembros = [];
  for (const p of participantes) {
    const id = p.id._serialized;
    const digitos = id.split('@')[0];

    // Nombre, por orden de preferencia:
    //  1) el que TÚ tienes guardado en la agenda del teléfono del bot
    //  2) el que la persona se ha puesto en WhatsApp (pushname)
    //  3) el que hayas fijado a mano en el CSV
    //  4) el que usó al escribir en el grupo
    //  5) su número
    let nombre = null;
    try {
      const c = await client.getContactById(id);
      // c.name = agenda del bot · c.pushname = el que usa la persona
      nombre = c.name || c.shortName || c.pushname || null;
    } catch (_) {}
    if (!nombre) nombre = sobrescrituras[digitos] || nombreDesdeBD(id);
    if (!nombre) nombre = `+${digitos}`;

    let foto = null;
    try {
      foto = await client.getProfilePicUrl(id);
    } catch (_) {
      foto = null; // privacidad: sin foto accesible
    }

    miembros.push({ id, nombre, foto });
  }

  let fotoGrupo = null;
  try {
    fotoGrupo = await client.getProfilePicUrl(chatId);
  } catch (_) {}

  const conFoto = miembros.filter((m) => m.foto).length;
  console.log(
    `[orla] ${miembros.length} miembros, ${conFoto} con foto` +
      (recortado ? ` (recortado a los ${MAX_ORLA} más activos)` : '')
  );

  const hoy = new Date().toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return {
    titulo: chat.name || 'Nuestro grupo',
    subtitulo: recortado
      ? `Los ${miembros.length} miembros más activos`
      : `${miembros.length} miembros`,
    pie: `${hoy}${recortado ? '' : ''}`,
    fotoGrupo,
    miembros,
  };
}

// ---- Grupos vigilados en los que participa una persona ----
// Necesario para el chat privado: el bot solo atiende a miembros de sus
// grupos, y solo les cuenta lo que ya pueden leer.
let cacheChats = { lista: null, ts: 0 };
const CHATS_TTL_MS = 5 * 60 * 1000;

async function gruposVigilados() {
  if (cacheChats.lista && Date.now() - cacheChats.ts < CHATS_TTL_MS) {
    return cacheChats.lista;
  }
  const todos = await client.getChats();
  const lista = todos
    .filter((c) => c.isGroup)
    .filter((c) => GROUP_IDS.length === 0 || GROUP_IDS.includes(c.id._serialized));
  cacheChats = { lista, ts: Date.now() };
  return lista;
}

async function gruposDelUsuario(userId) {
  const digitos = String(userId).split('@')[0].replace(/\D/g, '');
  const salida = [];
  for (const chat of await gruposVigilados()) {
    const dentro = (chat.participants || []).some(
      (p) =>
        p.id &&
        String(p.id._serialized).split('@')[0].replace(/\D/g, '') === digitos
    );
    if (dentro) {
      salida.push({ id: chat.id._serialized, nombre: chat.name || 'Grupo' });
    }
  }
  return salida;
}

async function gruposDondeEsAdmin(userId) {
  const digitos = String(userId).split('@')[0].replace(/\D/g, '');
  const salida = [];
  for (const g of await gruposDelUsuario(userId)) {
    const admins = await adminsDelGrupo(g.id);
    if (
      Array.isArray(admins) &&
      admins.some(
        (a) => String(a).split('@')[0].replace(/\D/g, '') === digitos
      )
    ) {
      salida.push(g);
    }
  }
  return salida;
}

const nombresChat = new Map();

// ---- Administradores reales del grupo ----
// WhatsApp ya sabe quién administra cada grupo: se le pregunta a él en
// vez de mantener listas a mano. Se cachea porque consultar el chat es
// una llamada al WhatsApp Web interno (lenta y a veces caprichosa) y no
// conviene hacerla en cada mensaje.
const cacheAdmins = new Map(); // chatId -> { ids: [], ts }
const ADMIN_TTL_MS = 10 * 60 * 1000;

async function adminsDelGrupo(chatId) {
  const cached = cacheAdmins.get(chatId);
  if (cached && Date.now() - cached.ts < ADMIN_TTL_MS) return cached.ids;

  try {
    const chat = await client.getChatById(chatId);
    if (!chat || !chat.isGroup || !Array.isArray(chat.participants)) return null;

    const ids = chat.participants
      .filter((p) => p.isAdmin || p.isSuperAdmin)
      .map((p) => (p.id && p.id._serialized) || null)
      .filter(Boolean);

    cacheAdmins.set(chatId, { ids, ts: Date.now() });
    console.log(`[admins] ${chatId}: ${ids.length} administrador(es)`);
    return ids;
  } catch (e) {
    console.error(`[admins] No pude leer los admins de ${chatId}:`, e.message);
    // Si ya se leyeron antes, se sigue usando esa lista aunque haya
    // caducado: es mejor que quedarse sin obedecer a nadie por un fallo
    // puntual de WhatsApp Web.
    return cached ? cached.ids : null;
  }
}

// Si cambian los administradores del grupo, se invalida su caché.
client.on('group_admin_changed', (notification) => {
  try {
    const gid =
      (notification && notification.chatId) ||
      (notification && notification.id && notification.id.remote);
    if (gid) {
      cacheAdmins.delete(gid);
      console.log(`[admins] Cambio de administradores en ${gid}`);
    }
  } catch (_) {}
});

async function nombreDelChat(msg, chatId) {
  if (nombresChat.has(chatId)) return nombresChat.get(chatId);
  let nombre = null;
  try {
    const chat = await msg.getChat();
    nombre = (chat && chat.name) || null;
  } catch (e) {
    console.error(`[capture] No pude leer el nombre del chat (${e.message})`);
  }
  nombresChat.set(chatId, nombre);
  return nombre;
}

async function atenderPrivado(msg) {
  try {
    if (msg.fromMe) return; // lo que envía el propio bot
    const from = msg.from || '';
    if (!from.endsWith('@c.us') && !from.endsWith('@lid')) return;

    let nombre = null;
    try {
      const c = await msg.getContact();
      nombre = c.name || c.pushname || null;
    } catch (_) {}

    const respuesta = await personal.handlePrivate(db, {
      body: msg.body || '',
      userId: from,
      nombre,
      botNumber:
        (client.info && client.info.wid && client.info.wid.user) || null,
      getGruposDelUsuario: () => gruposDelUsuario(from),
      getGruposComoAdmin: () => gruposDondeEsAdmin(from),
      getEnlaceCalendario: (chatId) => enlaceCalendario(from, chatId),
    });

    if (respuesta) await client.sendMessage(from, respuesta);
  } catch (err) {
    console.error('[privado] Error:', err.stack || err);
  }
}

// 'message_create' se dispara con cualquier mensaje del chat
// (entrantes y propios), sin necesidad de que tú lo abras/leas.
client.on('message_create', async (msg) => {
  // 1) Identificar el grupo SIN llamar a getChat(): el id del chat ya
  //    viene en el propio mensaje. En un grupo, uno de los dos extremos
  //    termina en @g.us (from si lo recibes, to si lo envías tú).
  let chatId = null;
  try {
    chatId = [msg.from, msg.to].find((id) => id && id.endsWith('@g.us')) || null;
  } catch (_) {}
  if (!chatId) {
    // ---- Chat privado ----
    await atenderPrivado(msg);
    return;
  }

  if (GROUP_IDS.length > 0 && !GROUP_IDS.includes(chatId)) return;

  const authorId = msg.author || msg.from || null;

  // 2) Guardar el mensaje. Aislado: si algo falla aquí, el bot todavía
  //    puede responder al comando.
  try {
    const authorName =
      (msg._data && (msg._data.notifyName || msg._data.pushName)) || null;

    insertStmt.run({
      id: msg.id._serialized,
      chat_id: chatId,
      chat_name: await nombreDelChat(msg, chatId),
      author_id: authorId,
      author_name: authorName,
      body: msg.body || '',
      type: msg.type || 'chat',
      ts: msg.timestamp || Math.floor(Date.now() / 1000),
      captured_at: Date.now(),
      // Mensajes enviados por la propia cuenta del bot: se guardan (para
      // tener el historial completo) pero se excluyen de resúmenes,
      // estadísticas y GIF, porque son ruido generado por él mismo.
      from_me: msg.fromMe ? 1 : 0,
      body_norm: util.norm(msg.body || ''),
    });

    // Log de descubrimiento: ayuda a encontrar el id del grupo y el tuyo.
    if (GROUP_IDS.length === 0) {
      console.log(
        `[grupo] "${nombresChat.get(chatId) || '?'}" id=${chatId} ` +
          `· autor=${authorId}`
      );
    }
  } catch (err) {
    console.error('[capture] Error guardando mensaje:', err.stack || err);
  }

  // 3) Comandos del bot. Con su propio try/catch y trazas completas.
  try {
    const reply = await qa.handleIncoming(db, {
      body: msg.body || '',
      authorId,
      chatId,
      docsDir: DOCS_DIR,
      // Admins reales del grupo (según WhatsApp). Null si no se pudo leer.
      getGroupAdmins: () => adminsDelGrupo(chatId),
      // Datos para la orla (participantes, nombres y fotos).
      getDatosOrla: (sobrescrituras) => datosOrla(chatId, sobrescrituras),
      // Enlace a la web del calendario (solo se entrega por privado).
      botNumber: (client.info && client.info.wid && client.info.wid.user) || null,
      getEnlaceCalendario: (uid, horas) => enlaceCalendario(uid, chatId, horas),
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
      fs.unlink(m.path, () => {}); // limpia el temporal
      if (m.path.endsWith('.mp4')) {
        fs.unlink(m.path.replace(/\.mp4$/, '.gif'), () => {});
      }
    }
  } catch (err) {
    console.error('[capture] Error respondiendo:', err.stack || err);
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

  // ---- Avisos diarios (cumpleaños y eventos) ----
  // Se revisan cada 15 min; el módulo solo actúa pasada la hora
  // configurada (p.ej. 11:30) y una sola vez por grupo, aviso y día.
  //
  // A qué grupos se escribe: a los que tengan CSV propio. Si ningún CSV
  // declara grupo, se cae a GROUP_IDS (comportamiento clásico de un solo
  // grupo). Nunca se avisa "a todos los grupos que haya" por si acaso:
  // sería spam en chats donde no toca.
  const resolverGrupos = () => {
    const declarados = groups.gruposConFichero(DOCS_DIR);
    const ids = declarados.length
      ? declarados.map((g) => ({ id: g.grupoId, fichero: g.fichero }))
      : GROUP_IDS.map((id) => ({ id, fichero: '(GROUP_IDS)' }));
    // Si GROUP_IDS está definido, actúa como lista blanca.
    return GROUP_IDS.length > 0
      ? ids.filter((x) => GROUP_IDS.includes(x.id))
      : ids;
  };

  const runAvisos = async () => {
    try {
      const destinos = resolverGrupos();
      for (const d of destinos) {
        try {
          const cfg = groups.paraChat(DOCS_DIR, d.id);
          const msgs = await avisos.pendientes(db, d.id, cfg);
          for (const text of msgs) {
            await client.sendMessage(d.id, text);
          }
        } catch (e) {
          console.error(`[avisos] Error en ${d.id}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[avisos] Error general:', e.message);
    }
  };

  runAvisos();
  setInterval(runAvisos, 15 * 60 * 1000);
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

// ---------- Web del calendario (público, con enlace firmado) ----------
const WEB_PORT = parseInt(process.env.WEB_PORT || '3001', 10);
const WEB_BASE = process.env.WEB_BASE_URL || '';
const secretoWeb = tokens.secretoDe(db);

web.arrancar({
  db,
  docsDir: DOCS_DIR,
  secreto: secretoWeb,
  puerto: WEB_PORT,
  // Cada cambio hecho por la web se anuncia en el grupo: si alguien usa un
  // enlace que no le correspondía, queda a la vista de todos.
  onCambio: async ({ chatId, userId, accion, texto }) => {
    try {
      let quien = nombreDesdeBD(userId);
      if (!quien) {
        try {
          const c = await client.getContactById(userId);
          quien = c.name || c.pushname || null;
        } catch (_) {}
      }
      await client.sendMessage(
        chatId,
        `🗓️ ${quien || 'Alguien'} ${accion} en el calendario: *${texto}*`
      );
    } catch (e) {
      console.error('[web] No pude avisar del cambio:', e.message);
    }
  },
  nombreDeGrupo: async (chatId) => {
    if (nombresChat.has(chatId)) return nombresChat.get(chatId);
    try {
      const chat = await client.getChatById(chatId);
      const n = (chat && chat.name) || null;
      nombresChat.set(chatId, n);
      return n;
    } catch (_) {
      return null;
    }
  },
});

/** Enlace de edición para un admin y un grupo. */
function enlaceCalendario(userId, chatId, horas) {
  if (!WEB_BASE) return null;
  const t = tokens.crear(
    secretoWeb,
    { userId, chatId },
    horas ? horas * 3600_000 : undefined
  );
  return `${WEB_BASE.replace(/\/$/, '')}/c/${encodeURIComponent(t)}`;
}

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
