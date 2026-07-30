# whatsapp-web.js usa Puppeteer -> necesita Chromium y sus librerías.
FROM node:20-bookworm-slim

# Dependencias de Chromium
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

# Que Puppeteer use el Chromium del sistema (no descargue otro)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

ENV NODE_ENV=production

WORKDIR /app
COPY package.json ./
# --omit=dev y sin scripts opcionales: imagen más pequeña y arranque limpio
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
