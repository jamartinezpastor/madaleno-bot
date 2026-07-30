'use strict';

/**
 * Generador del GIF de "qué se está hablando últimamente", con humor e ironía.
 *
 * Cómo funciona:
 *   1. Gemini lee la conversación reciente y devuelve JSON con una frase
 *      corta e irónica + 3-4 "escenas" (viñetas) para animar.
 *   2. Cada escena se renderiza como una tarjeta HTML/CSS y se captura con
 *      el Chromium que YA está corriendo para WhatsApp (no se lanza otro
 *      navegador: importante en un VPS modesto).
 *   3. Las capturas PNG se decodifican a RGBA y se codifican en un GIF
 *      animado con gifenc (JS puro, sin compilación nativa).
 *   4. Si hay ffmpeg, se convierte a MP4: WhatsApp reproduce en bucle los
 *      MP4 enviados con sendVideoAsGif, mientras que un .gif suele
 *      quedarse estático. Si no hay ffmpeg, se envía el .gif tal cual.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { PNG } = require('pngjs');
const gemini = require('./gemini');

const W = parseInt(process.env.GIF_WIDTH || '480', 10);
const H = parseInt(process.env.GIF_HEIGHT || '480', 10);
const FRAME_MS = parseInt(process.env.GIF_FRAME_MS || '1700', 10);

// Paleta de fondos para ir alternando entre escenas. El tercer color es
// el de la barra superior de acento, para que llame más la atención.
const BGS = [
  ['#1d3557', '#457b9d', '#ffd400'],
  ['#2d3142', '#4f5d75', '#ef8354'],
  ['#40323e', '#7d5a5a', '#f4d35e'],
  ['#22333b', '#5e807f', '#e63946'],
  ['#3d348b', '#7678ed', '#f7b32b'],
];

/** Pide a Gemini el guion del GIF. */
async function guion(transcripcion) {
  const system = `Eres un guionista de titulares con humor ácido, sarcasmo
e ironía afilada (nunca insultos, nada ofensivo ni personal contra nadie
en concreto). Te dan la conversación reciente de un grupo de WhatsApp y
escribes el guion de un GIF que tiene que ENGANCHAR nada más verse: cero
paja, directo al golpe, como un titular sensacionalista.

Decide TÚ cuántas escenas hacen falta, de 1 a 3, según dé de sí la
conversación:
- Si ha pasado UNA cosa clara y jugosa: UNA sola escena, la más incisiva
  posible, y ya. Menos es más.
- Si hay varios momentos con hilo entre ellos: hasta 3, con continuidad
  de historia (planteamiento → se tuerce → remate), nunca temas sueltos.

MUY IMPORTANTE: poquísimo texto, se lee en menos de 1 segundo por escena.
- "titulo": máximo 2 palabras (idealmente 1), tipo titular de prensa.
- "texto": máximo 26 caracteres. Un golpe seco y afilado, cero explicación.
- Prohibido: frases subordinadas, comas de más, "porque", "aunque".
- "frase" final: máximo 50 caracteres. El remate, lo más lapidario posible.

Devuelve SOLO JSON con esta forma exacta:
{
  "frase": "remate lapidario final",
  "escenas": [
    {"titulo": "1-2 palabras", "texto": "máx 26 caracteres", "emoji": "un emoji muy expresivo"}
  ]
}
Entre 1 y 3 escenas (tú decides cuántas, prioriza pocas y contundentes).
En español. Básate solo en lo que veas en la conversación; si el grupo
habló poco, el chiste va precisamente sobre eso, con más mordiente aún.`;

  return gemini.generateJson(system, transcripcion, {
    temperature: 0.95,
    maxTokens: 500,
  });
}

/** Recorta sin cortar palabras a media (por si el modelo se pasa). */
function recortar(s, max) {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  const esp = corte.lastIndexOf(' ');
  return (esp > max * 0.6 ? corte.slice(0, esp) : corte).trim() + '…';
}

/** HTML de una tarjeta. progreso 0..1 anima escala y aparición. */
function tarjetaHtml({ titulo, texto, emoji }, bg, progreso) {
  const scale = 0.92 + 0.08 * progreso;
  const op = Math.min(1, 0.35 + progreso * 1.2);
  const dy = (1 - progreso) * 16;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:${W}px;height:${H}px;overflow:hidden;
    font-family:"Noto Color Emoji","DejaVu Sans",system-ui,sans-serif;
    background:linear-gradient(135deg,${bg[0]},${bg[1]});
    display:flex;align-items:center;justify-content:center;position:relative}
  .barra{position:absolute;top:0;left:0;right:0;height:10px;
    background:${bg[2] || '#ffd400'}}
  .card{width:90%;text-align:center;color:#fff;
    transform:scale(${scale}) translateY(${dy}px);opacity:${op}}
  .emoji{font-size:190px;line-height:1;margin-bottom:14px;
    filter:drop-shadow(0 6px 14px rgba(0,0,0,.4))}
  .titulo{font-size:66px;font-weight:900;line-height:1.05;
    text-transform:uppercase;letter-spacing:.5px;
    text-shadow:0 4px 12px rgba(0,0,0,.4);margin-bottom:16px}
  .texto{font-size:38px;font-weight:700;opacity:.97;line-height:1.25}
  </style></head><body>
  <div class="barra"></div>
  <div class="card">
    <div class="emoji">${emoji || '💬'}</div>
    <div class="titulo">${esc(titulo || '')}</div>
    <div class="texto">${esc(texto || '')}</div>
  </div>
  </body></html>`;
}

function esc(s) {
  return String(s).replace(
    /[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]
  );
}

/** Convierte GIF a MP4 con ffmpeg (si está disponible). */
function gifToMp4(gifPath) {
  return new Promise((resolve) => {
    const mp4 = gifPath.replace(/\.gif$/, '.mp4');
    execFile(
      'ffmpeg',
      [
        '-y',
        '-i',
        gifPath,
        // Clave para que se respeten las pausas: el GIF tiene tiempos
        // variables por fotograma y el MP4 necesita cadencia constante.
        // Sin esto, ffmpeg remuestrea y la pausa larga del remate final
        // se pierde: el último fotograma "pasa volando".
        '-fps_mode',
        'cfr',
        '-r',
        '10',
        '-movflags',
        'faststart',
        '-pix_fmt',
        'yuv420p',
        // dimensiones pares: requisito de H.264
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        mp4,
      ],
      { timeout: 60000 },
      (err) => {
        if (err) {
          console.error('[gif] ffmpeg no disponible o falló:', err.message);
          resolve(null);
        } else {
          resolve(mp4);
        }
      }
    );
  });
}

/**
 * Crea el GIF.
 * @param {Function} getBrowser  devuelve el browser de Puppeteer ya abierto
 * @param {string} transcripcion conversación reciente
 * @returns {Promise<{path:string, mimetype:string, caption:string}>}
 */
async function crearGif(getBrowser, transcripcion) {
  const g = await guion(transcripcion);
  const escenas = Array.isArray(g.escenas) ? g.escenas.slice(0, 3) : [];
  if (escenas.length === 0) throw new Error('Gemini no devolvió escenas');

  const browser = getBrowser();
  if (!browser) throw new Error('El navegador de WhatsApp no está listo');

  const page = await browser.newPage();
  const frames = [];
  try {
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

    // Con una sola escena, sin gancho previo: directos al golpe, sin
    // paja. Con 2-3, un gancho brevísimo antes de arrancar la historia.
    const cards = [
      ...(escenas.length > 1
        ? [
            {
              titulo: 'Madaleno',
              texto: 'Esto se cuece aquí…',
              emoji: '🚨',
              ms: 900,
            },
          ]
        : []),
      ...escenas.map((e) => ({
        titulo: recortar(e.titulo, 18),
        texto: recortar(e.texto, 28),
        emoji: e.emoji || '💬',
        ms: FRAME_MS,
      })),
      {
        titulo: 'Remate',
        texto: recortar(g.frase, 52),
        emoji: '🎯',
        // El remate necesita bastante más tiempo: es lo único que hay que
        // leer entero y, en bucle, lo último antes de volver a empezar.
        ms: 4200,
        final: true,
      },
    ];

    for (let i = 0; i < cards.length; i++) {
      const bg = BGS[i % BGS.length];
      const c = cards[i];
      // Entrada rápida + reposo: da sensación de movimiento.
      await page.setContent(tarjetaHtml(c, bg, 0.35), { waitUntil: 'load' });
      frames.push({ buf: await page.screenshot({ type: 'png' }), ms: 160 });

      await page.setContent(tarjetaHtml(c, bg, 1), { waitUntil: 'load' });
      const reposo = await page.screenshot({ type: 'png' });
      if (c.final) {
        // Algunos reproductores recortan o ignoran una pausa larga en el
        // último fotograma. Repetirlo en varios trozos garantiza que se
        // vea tanto en el GIF como tras la conversión a MP4.
        const trozo = Math.round(c.ms / 3);
        frames.push({ buf: reposo, ms: trozo });
        frames.push({ buf: reposo, ms: trozo });
        frames.push({ buf: reposo, ms: trozo });
      } else {
        frames.push({ buf: reposo, ms: c.ms });
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  // Codificación GIF
  const enc = GIFEncoder();
  for (const f of frames) {
    const png = PNG.sync.read(f.buf);
    const rgba = new Uint8ClampedArray(png.data);
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    enc.writeFrame(index, W, H, { palette, delay: f.ms });
  }
  enc.finish();

  const gifPath = path.join(os.tmpdir(), `madaleno-${Date.now()}.gif`);
  fs.writeFileSync(gifPath, Buffer.from(enc.bytes()));

  // WhatsApp anima mejor un MP4 enviado con sendVideoAsGif.
  const mp4 = await gifToMp4(gifPath);
  return {
    path: mp4 || gifPath,
    mimetype: mp4 ? 'video/mp4' : 'image/gif',
    caption: g.frase || '',
    isVideo: !!mp4,
  };
}

module.exports = { crearGif };
