'use strict';

/**
 * Apertura de la base de datos, con cifrado opcional en reposo.
 *
 * Si existe DB_KEY, la base se cifra con SQLCipher (AES-256). Si ya
 * existía en claro, se migra automáticamente la primera vez, dejando una
 * copia de seguridad del fichero original.
 *
 * Qué protege esto y qué no:
 *  · Protege una copia de seguridad, un disco o un volumen robados: sin la
 *    clave, el fichero es ruido.
 *  · NO protege frente a quien tenga acceso al servidor: la clave está en
 *    las variables de entorno del contenedor, a su alcance.
 *
 * Si pierdes DB_KEY, pierdes el historial: no hay forma de recuperarlo.
 */

const fs = require('fs');
const Database = require('better-sqlite3-multiple-ciphers');

function escapar(clave) {
  return String(clave).replace(/'/g, "''");
}

function configurarCifrado(db, clave) {
  db.pragma('cipher = sqlcipher');
  db.pragma('legacy = 4');
  db.pragma(`key = '${escapar(clave)}'`);
}

/** ¿Se puede leer? Si la clave no corresponde, SQLite falla al leer. */
function seLee(db) {
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return true;
  } catch (_) {
    return false;
  }
}

/** Cifra una base que estaba en claro, conservando su contenido. */
function migrarACifrada(ruta, clave) {
  const copia = `${ruta}.enclaro.bak`;
  fs.copyFileSync(ruta, copia);
  console.log(`[db] Copia de seguridad sin cifrar en ${copia}`);

  const db = new Database(ruta);
  // Sin WAL durante la operación: evita rarezas con los ficheros -wal/-shm.
  db.pragma('journal_mode = DELETE');
  db.pragma('cipher = sqlcipher');
  db.pragma('legacy = 4');
  db.pragma(`rekey = '${escapar(clave)}'`);
  db.close();

  const cifrada = new Database(ruta);
  configurarCifrado(cifrada, clave);
  if (!seLee(cifrada)) {
    cifrada.close();
    throw new Error('La migración a base cifrada no se pudo verificar');
  }
  console.log('[db] Base de datos cifrada correctamente.');
  console.log(
    '[db] Comprueba que todo funciona y borra la copia sin cifrar a mano.'
  );
  return cifrada;
}

/**
 * Abre la base de datos aplicando cifrado si procede.
 * @returns {Database}
 */
function abrirInterno(ruta) {
  const clave = process.env.DB_KEY || '';
  const existe = fs.existsSync(ruta) && fs.statSync(ruta).size > 0;

  if (!clave) {
    const db = new Database(ruta);
    if (existe && !seLee(db)) {
      db.close();
      throw new Error(
        'La base de datos está cifrada y falta DB_KEY. Ponla en el .env ' +
          '(si la has perdido, el historial no se puede recuperar).'
      );
    }
    return db;
  }

  const db = new Database(ruta);
  configurarCifrado(db, clave);

  if (!existe || seLee(db)) {
    if (!existe) console.log('[db] Base de datos nueva, cifrada.');
    return db; // nueva, o ya cifrada con esta clave
  }

  // Existe pero no se abre con la clave. Tres posibilidades:
  // en claro (migramos), cifrada con la clave anterior (rotamos), o
  // clave equivocada (no se toca nada).
  db.close();

  const anterior = (process.env.DB_KEY_ANTERIOR || '').trim();
  if (anterior) {
    const conAnterior = new Database(ruta);
    configurarCifrado(conAnterior, anterior);
    if (seLee(conAnterior)) {
      console.log('[db] Rotando la clave de cifrado...');
      fs.copyFileSync(ruta, `${ruta}.antesderotar.bak`);
      conAnterior.pragma('journal_mode = DELETE');
      conAnterior.pragma(`rekey = '${escapar(clave)}'`);
      conAnterior.close();

      const nueva = new Database(ruta);
      configurarCifrado(nueva, clave);
      if (!seLee(nueva)) {
        nueva.close();
        throw new Error('La rotación de clave no se pudo verificar');
      }
      console.log('[db] Clave rotada. Quita ya DB_KEY_ANTERIOR del entorno');
      console.log('[db] y borra el fichero .antesderotar.bak.');
      return nueva;
    }
    conAnterior.close();
  }

  const enClaro = new Database(ruta);
  const legible = seLee(enClaro);
  enClaro.close();

  if (!legible) {
    throw new Error(
      'DB_KEY no abre la base de datos. Si has cambiado la clave, pon la ' +
        'anterior en DB_KEY_ANTERIOR y arranca: se rotará sola.'
    );
  }

  console.log('[db] Base en claro detectada: cifrando...');
  return migrarACifrada(ruta, clave);
}

/**
 * Abre la base y deja constancia de si quedó REALMENTE cifrada,
 * comprobando la cabecera del fichero en disco. Si pides cifrado y no se
 * consiguió, se avisa a gritos en los logs: es justo el caso en el que no
 * quieres enterarte tarde.
 */
function abrir(ruta) {
  const db = abrirInterno(ruta);
  const clave = process.env.DB_KEY || '';

  rutaBase = ruta;
  cifradaDeVerdad = ficheroCifrado(ruta);

  if (clave && cifradaDeVerdad === false) {
    console.error(
      '[db] ¡ATENCIÓN! DB_KEY está configurada pero el fichero NO está ' +
        'cifrado. Revisa los logs de arranque: la migración no se completó.'
    );
  } else if (clave && cifradaDeVerdad === true) {
    console.log('[db] Verificado: la base de datos está cifrada.');
  } else if (!clave && cifradaDeVerdad === false) {
    console.log('[db] Base de datos sin cifrar (no hay DB_KEY).');
  }

  return db;
}

/**
 * ¿Está el fichero realmente cifrado?
 *
 * No se fía de que exista DB_KEY: una variable de entorno dice lo que
 * PRETENDES, no lo que hay en disco. Un SQLite sin cifrar empieza siempre
 * por la cabecera "SQLite format 3"; si esos bytes no están, el contenido
 * está cifrado. Así el bot informa del estado real, y no puede mentir ni
 * diciendo "cifrado" cuando la migración falló, ni al revés.
 */
function ficheroCifrado(ruta) {
  try {
    if (!fs.existsSync(ruta) || fs.statSync(ruta).size === 0) return null;
    const fd = fs.openSync(ruta, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    return !buf.toString('utf8').startsWith('SQLite format 3');
  } catch (e) {
    console.error('[db] No pude comprobar el cifrado:', e.message);
    return null;
  }
}

// Estado real, calculado al abrir la base. null = no se pudo determinar.
let cifradaDeVerdad = null;
let rutaBase = null;

/**
 * Estado real del cifrado, para que el bot informe sin inventar.
 *
 * Si al arrancar el fichero estaba recién creado (0 bytes), no había
 * cabecera que leer y quedó como "no verificable"; en cuanto hay datos se
 * puede comprobar de verdad, así que se reintenta una vez.
 */
function estaCifrada() {
  if (cifradaDeVerdad === null && rutaBase) {
    cifradaDeVerdad = ficheroCifrado(rutaBase);
  }
  return cifradaDeVerdad;
}

module.exports = { abrir, estaCifrada, ficheroCifrado };
