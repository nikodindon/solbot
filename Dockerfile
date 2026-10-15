# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# solbot — image de production (Phase 5)
# Multi-étapes : build TypeScript puis runtime minimal (deps prod uniquement).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    SOLBOT_HOME=/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config ./config
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 9464
# Healthcheck natif (l'image slim n'a pas curl) : /healthz renvoie 503 si le
# dernier tick est trop vieux (moteur bloqué) ou si la base est indisponible.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9464/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js", "start"]
