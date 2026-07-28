'use strict';

/**
 * Cliente mínimo de la API de Google Gemini (Google AI Studio).
 *
 * Endpoint REST:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/<modelo>:generateContent
 *   Cabecera: x-goog-api-key: <API KEY>
 *
 * Se usa fetch nativo (Node >= 18): sin SDK ni dependencias extra.
 */

const API_BASE =
  process.env.GEMINI_API_BASE ||
  'https://generativelanguage.googleapis.com/v1beta';
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

/**
 * Genera texto.
 * @param {string} system   Instrucción de sistema (rol/estilo).
 * @param {string} user     Texto del usuario / contexto.
 * @param {object} opts     { maxTokens, temperature, json }
 * @returns {Promise<string>}
 */
async function generate(system, user, opts = {}) {
  if (!API_KEY) throw new Error('Falta GEMINI_API_KEY');

  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: opts.temperature !== undefined ? opts.temperature : 0.3,
      maxOutputTokens: opts.maxTokens || 700,
    },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  if (opts.json) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const url = `${API_BASE}/models/${MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Gemini ${r.status}: ${t.slice(0, 300)}`);
  }

  const data = await r.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    // Puede venir vacío si el filtro de seguridad bloqueó la respuesta.
    const reason = data.promptFeedback?.blockReason || 'sin candidatos';
    throw new Error(`Gemini no devolvió texto (${reason})`);
  }
  const parts = cand.content?.parts || [];
  return parts
    .map((p) => p.text || '')
    .join('')
    .trim();
}

/** Igual que generate() pero parsea la respuesta como JSON. */
async function generateJson(system, user, opts = {}) {
  const raw = await generate(system, user, { ...opts, json: true });
  const clean = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(clean);
}

module.exports = { generate, generateJson, MODEL };
