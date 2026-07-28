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
const FRAME_MS = parseInt(process.env.GIF_FRAME_MS || '1400', 10);

// Paleta de fondos para ir alternando entre escenas.
const BGS = [
  ['#1d3557', '#457b9d'],
  ['#2d3142', '#4f5d75'],
  ['#40323e', '#7d5a5a'],
  ['#22333b', '#5e807f'],
  ['#3d348b', '#7678ed'],
];

/** Pide a Gemini el guion del GIF. */
async function guion(transcripcion) {
  const system = `Eres un guionista con humor ácido e ironía fina (nunca
insultos, nada ofensivo ni personal). Te dan la conversación reciente de un
grupo de WhatsApp y devuelves un guion cortito para un GIF.

Devuelve SOLO JSON con esta forma exacta:
{
  "frase": "una frase corta e irónica que resuma el ambiente del grupo (máx 90 caracteres)",
  "escenas": [
    {"titulo": "tema en 2-4 palabras", "texto": "coletilla irónica de máx 60 caracteres", "emoji": "un emoji"},
    ... entre 3 y 4 escenas ...
  ]
}
Habla en español. Básate solo en lo que veas en la conversación; si el
grupo habló poco, ironiza precisamente sobre eso.`;

  return gemini.generateJson(system, transcripcion, {
    temperature: 0.9,
    maxTokens: 600,
  });
}

/** HTML de una tarjeta. progreso 0..1 anima escala y aparición. */
function tarjetaHtml({ titulo, texto, emoji }, bg, progreso, pie) {
  const scale = 0.94 + 0.06 * progreso;
  const op = Math.min(1, 0.35 + progreso * 1.2);
  const dy = (1 - progreso) * 14;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:${W}px;height:${H}px;overflow:hidden;
    font-family:"Noto Color Emoji","DejaVu Sans",system-ui,sans-serif;
    background:linear-gradient(135deg,${bg[0]},${bg[1]});
    display:flex;align-items:center;justify-content:center}
  .card{width:86%;text-align:center;color:#fff;
    transform:scale(${scale}) translateY(${dy}px);opacity:${op}}
  .emoji{font-size:96px;line-height:1.1;margin-bottom:14px}
  .titulo{font-size:40px;font-weight:800;line-height:1.15;
    text-shadow:0 3px 10px rgba(0,0,0,.35);margin-bottom:12px}
  .texto{font-size:25px;font-weight:500;opacity:.93;line-height:1.3}
  .pie{position:absolute;bottom:18px;width:100%;text-align:center;
    font-size:16px;opacity:.55;color:#fff;letter-spacing:.5px}
  </style></head><body>
  <div class="card">
    <div class="emoji">${emoji || '💬'}</div>
    <div class="titulo">${esc(titulo || '')}</div>
    <div class="texto">${esc(texto || '')}</div>
  </div>
  ${pie ? `<div class="pie">${esc(pie)}</div>` : ''}
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
  const escenas = Array.isArray(g.escenas) ? g.escenas.slice(0, 4) : [];
  if (escenas.length === 0) throw new Error('Gemini no devolvió escenas');

  const browser = getBrowser();
  if (!browser) throw new Error('El navegador de WhatsApp no está listo');

  const page = await browser.newPage();
  const frames = [];
  try {
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

    // Portada + escenas + cierre con la frase.
    const cards = [
      { titulo: 'Madaleno informa', texto: 'Qué se cuece últimamente', emoji: '📡' },
      ...escenas,
      { titulo: 'En resumen', texto: g.frase || '', emoji: '🤷' },
    ];

    for (let i = 0; i < cards.length; i++) {
      const bg = BGS[i % BGS.length];
      // 2 fotogramas por tarjeta: entrada + reposo (da sensación de animación)
      for (const progreso of [0.35, 1]) {
        await page.setContent(
          tarjetaHtml(cards[i], bg, progreso, `${i + 1}/${cards.length}`),
          { waitUntil: 'load' }
        );
        const buf = await page.screenshot({ type: 'png' });
        frames.push({ buf, hold: progreso === 1 });
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
    enc.writeFrame(index, W, H, {
      palette,
      delay: f.hold ? FRAME_MS : 180, // entrada rápida, reposo largo
    });
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
