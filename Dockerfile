# =========================================================================
# Stage 1: Compile the BepInEx Live Map & Health Exporter Plugin (.dll)
# =========================================================================
FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS plugin-builder
WORKDIR /src
COPY bepinex-plugin ./
RUN dotnet build WatchtowerMapExporter.csproj -c Release -o /out

# =========================================================================
# Stage 2: Heimdall Watchtower Node.js Dashboard Container
# =========================================================================
FROM node:20-alpine

LABEL org.opencontainers.image.source="https://github.com/oliver-poulter/valheimmonitor"
LABEL org.opencontainers.image.description="Heimdall Watchtower — Companion Web Dashboard & Live World Map for lloesche/valheim-server"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install production dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy application source & compiled BepInEx plugin DLL
COPY server ./server
COPY public ./public
COPY bepinex-plugin ./bepinex-plugin
COPY --from=plugin-builder /out/WatchtowerMapExporter.dll ./bepinex-plugin/WatchtowerMapExporter.dll

ENV NODE_ENV=production
ENV PORT=3000
ENV VALHEIM_CONFIG_DIR=/config
ENV VALHEIM_CONTAINER_NAME=valheim-server
ENV AUTO_CONFIGURE_SERVER=false

EXPOSE 3000

CMD ["node", "server/index.js"]
