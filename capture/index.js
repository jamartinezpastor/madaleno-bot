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
const admins = require('./admins');
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
admins.initSchema(db);

// Si no se configura un código de alta, se genera uno y se muestra aquí:
// así no hay que inventarse ni configurar nada, basta con mirar los logs.
if (!process.env.ADMIN_SETUP_CODE) {
  process.env.ADMIN_SETUP_CODE = require('crypto')
    .randomBytes(3)
    .toString('hex')
    .toUpperCase();
  console.log(
    `[admins] Código de alta de esta sesión: ${process.env.ADMIN_SETUP_CODE}\n` +
      '         Solo hace falta si no puedo leer los admins de WhatsApp.'
  );
}

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

function participantesDesdeBD(chatId) {
  try {
    return db
      .prepare(
        `SELECT DISTINCT author_id AS id FROM messages
          WHERE chat_id = ? AND author_id IS NOT NULL AND from_me = 0`
      )
      .all(chatId)
      .map((r) => ({ id: r.id, isAdmin: false }));
  } catch (e) {
    console.error('[orla] Respaldo por BD falló:', e.message);
    return [];
  }
}

async function datosOrla(chatId, sobrescrituras = {}) {
  // El nombre del grupo y sus participantes se leen del store
  // (grupoPorStore), no de getChatById (misma llamada rota que ya dio
  // problemas con los admins). Si el store falla, se recurre a quienes
  // hayan escrito alguna vez en el chat según nuestra propia base de
  // datos: no es una lista tan completa (quien nunca escribió no sale),
  // pero es mucho mejor que dejar la orla completamente inoperativa.
  let g = await grupoPorStore(chatId);
  let porRespaldo = false;
  if (!g || !Array.isArray(g.participantes) || g.participantes.length === 0) {
    const respaldo = participantesDesdeBD(chatId);
    if (respaldo.length === 0) {
      throw new Error(
        'No consigo leer los miembros del grupo ahora mismo (fallo de WhatsApp Web) ' +
          'y tampoco tengo mensajes previos de nadie en este chat.'
      );
    }
    console.log(
      `[orla] Store no disponible, uso ${respaldo.length} miembro(s) por ` +
        'historial de mensajes.'
    );
    g = { participantes: respaldo, subject: null };
    porRespaldo = true;
  }

  const yo = client.info && client.info.wid && client.info.wid._serialized;
  let participantes = g.participantes.filter(
    (p) => p.id && p.id !== yo // el bot no sale en su propia orla
  );

  // En grupos muy grandes, los más participativos.
  let recortado = false;
  if (participantes.length > MAX_ORLA) {
    const cuenta = mensajesPorAutor(chatId);
    participantes = participantes
      .sort((a, b) => (cuenta.get(b.id) || 0) - (cuenta.get(a.id) || 0))
      .slice(0, MAX_ORLA);
    recortado = true;
  }

  // Las llamadas a WhatsApp Web (contacto y foto) no tienen tiempo límite
  // propio: en un grupo de 25 personas son 50 peticiones de red y basta
  // que UNA se cuelgue para que la orla se quede esperando eternamente,
  // sin error ni respuesta. Se acotan con timeout y se lanzan por lotes
  // en paralelo, así el tiempo total es predecible.
  const conTimeout = (promesa, ms, siFalla = null) =>
    Promise.race([
      Promise.resolve(promesa).catch(() => siFalla),
      new Promise((r) => setTimeout(() => r(siFalla), ms)),
    ]);

  const LOTE = 6;
  const TIMEOUT_MS = parseInt(process.env.ORLA_TIMEOUT_MS || '4000', 10);
  const miembros = [];

  for (let i = 0; i < participantes.length; i += LOTE) {
    const lote = participantes.slice(i, i + LOTE);
    const resueltos = await Promise.all(
      lote.map(async (p) => {
        const id = p.id;
        const digitos = id.split('@')[0];

        // Nombre, por orden de preferencia:
        //  1) el que TÚ tienes guardado en la agenda del teléfono del bot
        //  2) el que la persona se ha puesto en WhatsApp (pushname)
        //  3) el que hayas fijado a mano en el CSV
        //  4) el que usó al escribir en el grupo
        //  5) su número
        let nombre = null;
        const c = await conTimeout(client.getContactById(id), TIMEOUT_MS);
        if (c) nombre = c.name || c.shortName || c.pushname || null;
        if (!nombre) nombre = sobrescrituras[digitos] || nombreDesdeBD(id);
        if (!nombre) nombre = `+${digitos}`;

        // Sin foto accesible (privacidad o timeout) se usa el avatar de
        // iniciales, que ya contempla el módulo de la orla.
        const foto = await conTimeout(client.getProfilePicUrl(id), TIMEOUT_MS);

        return { id, nombre, foto };
      })
    );
    miembros.push(...resueltos);
  }

  const fotoGrupo = await conTimeout(
    client.getProfilePicUrl(chatId),
    TIMEOUT_MS
  );

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
    titulo: g.subject || nombresChat.get(chatId) || 'Nuestro grupo',
    subtitulo: recortado
      ? `Los ${miembros.length} miembros más activos`
      : `${miembros.length} miembros`,
    pie: hoy,
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
  // No depende de client.getChats() (el mismo bug de "Puppeteer error r: r"
  // que afecta a getChatById): los ids de grupo salen de nuestra propia
  // base de datos, que ya los conoce por haber capturado sus mensajes.
  let ids = [];
  try {
    ids = db
      .prepare("SELECT DISTINCT chat_id FROM messages WHERE chat_id LIKE '%@g.us'")
      .all()
      .map((r) => r.chat_id);
  } catch (e) {
    console.error('[grupos] No pude listar grupos de la BD:', e.message);
  }
  if (GROUP_IDS.length > 0) {
    // Incluye los configurados aunque aún no tengan mensajes capturados
    // (grupo recién añadido) y descarta cualquier otro.
    for (const g of GROUP_IDS) if (!ids.includes(g)) ids.push(g);
    ids = ids.filter((id) => GROUP_IDS.includes(id));
  }
  const lista = ids.map((id) => ({ id, nombre: nombresChat.get(id) || null }));
  cacheChats = { lista, ts: Date.now() };
  return lista;
}

function haEscritoAlgunaVez(chatId, digitos) {
  try {
    return db
      .prepare('SELECT DISTINCT author_id FROM messages WHERE chat_id = ?')
      .all(chatId)
      .some((f) => util.soloDigitos(f.author_id) === digitos);
  } catch (_) {
    return false;
  }
}

async function gruposDelUsuario(userId) {
  const digitos = util.soloDigitos(userId);
  const salida = [];
  for (const chat of await gruposVigilados()) {
    let esMiembro = false;
    let subject = chat.nombre;

    // 1) Comprobación en vivo vía store: la fuente más fiable si funciona.
    try {
      const g = await grupoPorStore(chat.id);
      if (g) {
        esMiembro = g.participantes.some(
          (p) => util.soloDigitos(p.id) === digitos
        );
        subject = subject || g.subject;
      }
    } catch (_) {}

    // 2) Respaldo: si el store falla pero esta persona ha escrito alguna
    //    vez en este chat según nuestra base de datos, se le trata como
    //    miembro. Mejor un falso positivo ocasional (alguien que se fue
    //    del grupo) que dejar el resumen personal completamente inoperativo.
    if (!esMiembro) esMiembro = haEscritoAlgunaVez(chat.id, digitos);

    if (esMiembro) {
      salida.push({ id: chat.id, nombre: subject || 'Grupo' });
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

// Estancia temporal: bug abierto y sin resolver en whatsapp-web.js donde
// getChatById falla con un "Puppeteer error r: r" tras actualizaciones
// recientes de WhatsApp Web (github.com/wwebjs/whatsapp-web.js#201838,
// reproducido incluso en la última versión estable). Mientras dure,
// ADMIN_FALLBACK_IDS permite seguir operando sin depender de esa llamada.
/**
 * Lee del almacén interno de WhatsApp Web todo lo que antes se pedía con
 * getChatById: participantes (con su condición de admin), nombre del
 * grupo y quién es cada uno. Una sola llamada evaluate(), reutilizada por
 * adminsDelGrupo, datosOrla y gruposDelUsuario: los tres dejaron de
 * depender de getChatById/getChats, que es lo que falla.
 */
async function grupoPorStore(chatId) {
  if (!client.pupPage) return null;

  const res = await client.pupPage
    .evaluate(async (id) => {
      try {
        const S = window.Store;
        if (!S || !S.GroupMetadata) return { error: 'sin store' };

        let meta = S.GroupMetadata.get ? S.GroupMetadata.get(id) : null;
        if ((!meta || !meta.participants) && S.GroupMetadata.find) {
          meta = await S.GroupMetadata.find(id);
        }
        const p = meta && meta.participants;
        if (!p) return { error: 'sin participantes' };

        const lista = p.getModelsArray
          ? p.getModelsArray()
          : Array.isArray(p)
            ? p
            : p._models || [];

        const idDe = (i) => {
          if (!i) return null;
          if (typeof i === 'string') return i;
          if (i._serialized) return i._serialized;
          return i.user ? `${i.user}@${i.server || 'c.us'}` : null;
        };

        const participantes = lista
          .map((x) => ({
            id: idDe(x && x.id),
            isAdmin: !!(x && (x.isAdmin || x.isSuperAdmin)),
          }))
          .filter((x) => x.id);

        const subject =
          (meta && (meta.subject || meta.name)) ||
          (S.Chat && S.Chat.get && S.Chat.get(id) && S.Chat.get(id).name) ||
          null;

        return { participantes, subject, total: lista.length };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    }, chatId)
    .catch((e) => ({ error: String((e && e.message) || e) }));

  if (!res || res.error) {
    console.error(`[store] ${chatId}: ${(res && res.error) || 'sin respuesta'}`);
    return null;
  }
  return res;
}

async function adminsPorStore(chatId) {
  const g = await grupoPorStore(chatId);
  if (!g) return null;
  const admins = g.participantes.filter((p) => p.isAdmin).map((p) => p.id);
  console.log(`[admins] Store: ${admins.length} admin(es) de ${g.total} miembros`);
  return admins;
}

async function adminsDelGrupo(chatId, intento = 0) {
  const cached = cacheAdmins.get(chatId);
  if (cached && Date.now() - cached.ts < ADMIN_TTL_MS) return cached.ids;

  // 1) Camino propio: leer el almacén interno. Evita el bug de la librería.
  try {
    const porStore = await adminsPorStore(chatId);
    if (Array.isArray(porStore) && porStore.length > 0) {
      cacheAdmins.set(chatId, { ids: porStore, ts: Date.now() });
      return porStore;
    }
  } catch (e) {
    console.error('[admins] Store falló:', e.message);
  }

  // 2) Camino de la librería (por si algún día vuelve a funcionar).
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
    // Un reintento corto: a veces falla justo tras 'ready', antes de que
    // el store interno de WhatsApp Web termine de cargar.
    if (intento === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return adminsDelGrupo(chatId, 1);
    }
    console.error(`[admins] No pude leer los admins de ${chatId}:`, e.message);
    // No pasa nada: la autorización usa el registro propio del bot.
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
      body: normalizarMencionAlBot(msg, msg.body || ''),
      userId: from,
      nombre,
      botNumber:
        (client.info && client.info.wid && client.info.wid.user) || null,
      getGruposDelUsuario: () => gruposDelUsuario(from),
      getGruposComoAdmin: () => gruposDondeEsAdmin(from),
      getEnlaceCalendario: (chatId) => enlaceCalendario(from, chatId),
    });

    if (respuesta) await client.sendMessage(from, util.firmar(respuesta));
  } catch (err) {
    console.error('[privado] Error:', err.stack || err);
  }
}

// 'message_create' se dispara con cualquier mensaje del chat
// (entrantes y propios), sin necesidad de que tú lo abras/leas.
/**
 * Cuando el número del bot está guardado en la agenda de quien escribe
 * (p.ej. como "Madaleno"), WhatsApp puede convertir "@Madaleno" en una
 * MENCIÓN REAL en vez de dejarlo como texto. El cuerpo que llega entonces
 * no es "@Madaleno info": suele ser "@<número o LID> info", con el nombre
 * mostrado solo como sustitución visual en la pantalla. Comparar ese
 * texto contra "@madaleno" nunca coincide, así que el bot se queda mudo
 * SOLO para quien tiene el contacto guardado, sea cual sea la
 * mayúscula/minúscula usada — no es un problema de mayúsculas.
 *
 * Aquí se detecta esa mención real (msg.mentionedIds incluye al propio
 * bot) y se sustituye el primer token "@algo" por el disparador
 * configurado, para que el resto del bot vea siempre lo mismo que si se
 * hubiera escrito a mano.
 */
function normalizarMencionAlBot(msg, textoOriginal) {
  try {
    const yo = client.info && client.info.wid && client.info.wid._serialized;
    if (!yo || !Array.isArray(msg.mentionedIds) || msg.mentionedIds.length === 0) {
      return textoOriginal;
    }
    const meMencionan = msg.mentionedIds.some((id) => util.mismoNumero(id, yo));
    if (!meMencionan) {
      // Diagnóstico: si esto sale con frecuencia y el mensaje va dirigido
      // claramente al bot, es probable que mentionedIds use un formato
      // (LID) distinto al de client.info.wid (número clásico), y esta
      // normalización no podría detectarlo. Este log ayuda a confirmarlo
      // sin tener que adivinar.
      console.log(
        `[mencion] Mención sin identificar como propia. yo=${yo} ` +
          `mentionedIds=${msg.mentionedIds.join(',')}`
      );
      return textoOriginal;
    }

    const t = String(textoOriginal || '');
    // Si ya empieza con el disparador en texto plano, no hay nada que
    // normalizar (lo escribieron a mano, no es una mención real).
    if (t.trim().toLowerCase().startsWith(util.TRIGGER)) return t;

    return t.replace(/^@\S+\s*/, `${util.TRIGGER} `);
  } catch (e) {
    console.error('[mencion] Error normalizando:', e.message);
    return textoOriginal;
  }
}

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

  // Si es una mención real al bot (contacto guardado en la agenda de quien
  // escribe), el cuerpo crudo no empieza por el disparador de texto. Se
  // normaliza una sola vez y se usa tanto para guardar como para procesar
  // el comando, así el resto del bot no necesita saber nada de menciones.
  const bodyNormalizado = normalizarMencionAlBot(msg, msg.body || '');

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
      body: bodyNormalizado,
      type: msg.type || 'chat',
      ts: msg.timestamp || Math.floor(Date.now() / 1000),
      captured_at: Date.now(),
      // Mensajes enviados por la propia cuenta del bot: se guardan (para
      // tener el historial completo) pero se excluyen de resúmenes,
      // estadísticas y GIF, porque son ruido generado por él mismo.
      from_me: msg.fromMe ? 1 : 0,
      body_norm: util.norm(bodyNormalizado),
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
      body: bodyNormalizado,
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
      // Mensaje citado: permite dar de alta a alguien respondiéndole.
      citado: msg.hasQuotedMsg
        ? { autorId: (msg._data && msg._data.quotedParticipant) || null }
        : null,
      // El GIF se renderiza con el Chromium que ya usa WhatsApp Web.
      getBrowser: () => client.pupBrowser,
    });

    if (typeof reply === 'string' && reply) {
      await client.sendMessage(chatId, util.firmar(reply));
    } else if (reply && reply.media) {
      // GIF/MP4 generado por @madaleno gif
      const m = reply.media;
      const media = MessageMedia.fromFilePath(m.path);
      await client.sendMessage(chatId, media, {
        caption: util.firmar(m.caption || ''),
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

/**
 * Serializa un id de mensaje de WhatsApp al formato "fromMe_remote_id".
 *
 * El evento 'message_reaction' no siempre entrega un objeto de mensaje
 * completamente hidratado: a veces `msgId._serialized` no existe. La
 * versión anterior caía entonces en `String(reaction.msgId)`, que para
 * cualquier objeto plano sin `toString()` propio da la cadena constante
 * "[object Object]" — SIEMPRE la misma, para cualquier mensaje. Como la
 * clave de la tabla de reacciones es (msg_id, reactor_id), todas las
 * reacciones de una misma persona a mensajes distintos colisionaban en
 * la misma fila y se sobrescribían: por eso el contador se quedaba
 * siempre en 1, por muchas veces que esa persona reaccionara.
 */
function serializarMsgId(msgId) {
  if (!msgId) return null;
  if (msgId._serialized) return msgId._serialized;
  if (msgId.id && msgId.remote !== undefined) {
    return `${msgId.fromMe ? 'true' : 'false'}_${msgId.remote}_${msgId.id}`;
  }
  return null;
}

// Captura de reacciones (👍❤️😂...). WhatsApp emite 'message_reaction'
// tanto al poner como al quitar una reacción (emoji vacío = retirada).
client.on('message_reaction', (reaction) => {
  try {
    const chatId =
      (reaction.id && reaction.id.remote) || reaction.msgId?.remote || null;
    if (!chatId) return;
    if (GROUP_IDS.length > 0 && !GROUP_IDS.includes(chatId)) return;

    const msgId = serializarMsgId(reaction.msgId);
    if (!msgId) {
      // Sin un id fiable no se puede distinguir de qué mensaje viene la
      // reacción: mejor descartarla que guardar una fila que colisione
      // con otras y falsee las estadísticas.
      console.error(
        '[reacciones] Sin id de mensaje fiable, descartada:',
        JSON.stringify(reaction).slice(0, 200)
      );
      return;
    }

    upsertReaction.run({
      msg_id: msgId,
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
            await client.sendMessage(d.id, util.firmar(text));
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
        util.firmar(
          `🗓️ ${quien || 'Alguien'} ${accion} en el calendario: *${texto}*`
        )
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
