# ---------- Fase 1: dependencias ----------
# Los módulos nativos (SQLite con cifrado) no siempre tienen binario
# precompilado para cada versión de Node, así que aquí se compila si hace
# falta. Los compiladores se quedan en esta fase: no van a la imagen final.
FROM node:20-bookworm-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---------- Fase 2: imagen final ----------
FROM node:20-bookworm-slim

# Chromium (para WhatsApp Web, el GIF y la orla), ffmpeg y emojis a color
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      fonts-noto-color-emoji \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libc6 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libexpat1 \
      libfontconfig1 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxrandr2 \
      libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 3000 3001
CMD ["node", "index.js"]
