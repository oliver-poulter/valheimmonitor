FROM node:20-alpine

LABEL org.opencontainers.image.source="https://github.com/oliver-poulter/valheimmonitor"
LABEL org.opencontainers.image.description="Heimdall Watchtower — Companion Web Dashboard & Live World Map for lloesche/valheim-server"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install production dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy application source & BepInEx telemetry plugin
COPY server ./server
COPY public ./public
COPY bepinex-plugin ./bepinex-plugin

ENV NODE_ENV=production
ENV PORT=3000
ENV VALHEIM_CONFIG_DIR=/config
ENV VALHEIM_CONTAINER_NAME=valheim-server

EXPOSE 3000

CMD ["node", "server/index.js"]
