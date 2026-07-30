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
function abrir(ruta) {
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

module.exports = { abrir };
