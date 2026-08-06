'use strict';

/**
 * Utilidades compartidas. Antes estaban duplicadas en media docena de
 * ficheros, con pequeñas variaciones que ya habían causado algún fallo.
 */

/** Minúsculas y sin tildes: la forma canónica para comparar texto. */
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/** Solo los dígitos de un identificador de WhatsApp (34600...@c.us / @lid). */
function soloDigitos(id) {
  return String(id || '').split('@')[0].replace(/\D/g, '');
}

/** ¿Coincide el autor con alguno de la lista, sea cual sea el formato? */
function mismoNumero(a, b) {
  const x = soloDigitos(a);
  return x !== '' && x === soloDigitos(b);
}

/**
 * Limitador por clave con purga automática.
 * El anterior guardaba una entrada por usuario para siempre; en un bot que
 * corre meses, eso es una fuga de memoria lenta pero segura.
 */
function crearLimitador(porHora) {
  const mapa = new Map();
  let ultimaPurga = Date.now();

  return function permitir(clave, limite = porHora) {
    const ahora = Date.now();
    const desde = ahora - 3600_000;

    // Purga perezosa: cada 10 minutos se tiran las claves inactivas.
    if (ahora - ultimaPurga > 600_000) {
      for (const [k, v] of mapa) {
        const vivos = v.filter((t) => t > desde);
        if (vivos.length === 0) mapa.delete(k);
        else mapa.set(k, vivos);
      }
      ultimaPurga = ahora;
    }

    const usos = (mapa.get(clave) || []).filter((t) => t > desde);
    if (usos.length >= limite) return false;
    usos.push(ahora);
    mapa.set(clave, usos);
    return true;
  };
}

/**
 * Caché de sentencias preparadas.
 * better-sqlite3 recomienda preparar una vez y reutilizar: hacerlo en cada
 * llamada obliga a SQLite a analizar el SQL una y otra vez.
 */
const sentencias = new WeakMap();

function stmt(db, sql) {
  let porDb = sentencias.get(db);
  if (!porDb) {
    porDb = new Map();
    sentencias.set(db, porDb);
  }
  let s = porDb.get(sql);
  if (!s) {
    s = db.prepare(sql);
    porDb.set(sql, s);
  }
  return s;
}

/**
 * Fragmento SQL para quedarnos con mensajes que tienen contenido real.
 *
 * Antes se exigía `type = 'chat'`, lo que descartaba fotos, vídeos y
 * documentos enviados CON PIE DE FOTO: WhatsApp les pone un tipo distinto
 * de 'chat' aunque tengan texto. Eso hacía que buscar o preguntar por
 * algo mencionado en un pie de foto no encontrara nada. Se excluye solo
 * lo que nunca es contenido de una persona (notificaciones de sistema,
 * mensajes borrados, llamadas).
 */
const SQL_CON_CONTENIDO =
  "type NOT IN ('e2e_notification','notification_template','notification'," +
  "'call_log','gp2','revoked','ciphertext')";

/** Disparador del bot, centralizado para que todos los módulos vean el mismo. */
const TRIGGER = (process.env.BOT_TRIGGER || '@madaleno').toLowerCase();

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Reconoce el disparador como palabra suelta en cualquier punto del texto
// ("oye @madaleno, ¿qué tal?" o "¿me resumes esto @madaleno?"), no solo al
// principio. El lookbehind/lookahead evita falsos positivos como
// "@madalenoso" o un correo "algo@madaleno.com".
const MENTION_RE = new RegExp(
  '(^|[\\s¿¡(«"\'])' + escapeRegExp(TRIGGER) + '(?=$|[\\s.,;:!?)»"\'])',
  'i'
);

/**
 * Busca el disparador del bot en todo el texto, no solo al principio.
 * Devuelve lo que queda del mensaje al quitar el token de mención (el
 * "comando o pregunta" que el resto del bot debe analizar), o null si el
 * bot no está mencionado.
 *
 * Cuando la mención abre el mensaje se mantiene el comportamiento de
 * siempre (recorte simple, sin tocar mayúsculas ni espacios del resto).
 * Cuando aparece en medio o al final, se quita solo el token y se une lo
 * que quedaba antes y después.
 */
function detectarMencion(texto) {
  const trimmed = String(texto == null ? '' : texto).trim();
  if (!trimmed) return null;
  // Atajo para el caso de siempre (mención al principio), pero exigiendo
  // que el disparador termine ahí: "@madalenoso" no debe colar como
  // mención solo por empezar igual.
  if (trimmed.toLowerCase().startsWith(TRIGGER)) {
    const siguiente = trimmed.charAt(TRIGGER.length);
    if (!siguiente || /[\s.,;:!?)»"']/.test(siguiente)) {
      return trimmed.slice(TRIGGER.length).trim();
    }
  }
  const m = trimmed.match(MENTION_RE);
  if (!m) return null;
  return (trimmed.slice(0, m.index) + ' ' + trimmed.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Marca que cierra todos los mensajes del bot. */
const FIRMA = '🫴🏻🪙';

/**
 * Añade la firma al final de cualquier mensaje del bot, en su propia
 * línea. No la duplica si ya está (por ejemplo, si un texto ya firmado
 * vuelve a pasar por aquí).
 */
function firmar(texto) {
  const t = String(texto == null ? '' : texto).replace(/\s+$/, '');
  if (!t) return t;
  if (t.endsWith(FIRMA)) return t;
  return `${t}\n\n${FIRMA}`;
}

module.exports = {
  norm,
  soloDigitos,
  mismoNumero,
  crearLimitador,
  stmt,
  SQL_CON_CONTENIDO,
  TRIGGER,
  detectarMencion,
  FIRMA,
  firmar,
};
