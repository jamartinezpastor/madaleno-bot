"use strict";

/**
 * Utilidades compartidas. Antes estaban duplicadas en media docena de
 * ficheros, con pequeñas variaciones que ya habían causado algún fallo.
 */

/** Minúsculas y sin tildes: la forma canónica para comparar texto. */
function norm(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Solo los dígitos de un identificador de WhatsApp.
 *
 * Sirve tanto para identificadores (34600111222@c.us, 277245...@lid) como
 * para menciones (@277245...), donde los dígitos van DESPUÉS de la arroba:
 * dividir por "@" y quedarse con la primera parte devolvía vacío y hacía
 * que el bot no se reconociera al ser mencionado.
 */
function soloDigitos(id) {
  return String(id || "").replace(/\D/g, "");
}

/** ¿Coincide el autor con alguno de la lista, sea cual sea el formato? */
function mismoNumero(a, b) {
  const x = soloDigitos(a);
  return x !== "" && x === soloDigitos(b);
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
const TRIGGER = (process.env.BOT_TRIGGER || "@madaleno").toLowerCase();

/** Marca que cierra todos los mensajes del bot. */
const FIRMA = "🫴🏻🪙";

/**
 * Añade la firma al final de cualquier mensaje del bot, en su propia
 * línea. No la duplica si ya está (por ejemplo, si un texto ya firmado
 * vuelve a pasar por aquí).
 */
function firmar(texto) {
  const t = String(texto == null ? "" : texto).replace(/\s+$/, "");
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
  FIRMA,
  firmar,
};
