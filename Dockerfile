# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/functions/package.json ./apps/functions/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/adapters/package.json ./packages/adapters/package.json
RUN npm ci
COPY tsconfig.base.json tsconfig.server.json ./
COPY apps ./apps
COPY packages ./packages
COPY tools ./tools
COPY tests ./tests
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
# flock protects the volume across PID namespaces and releases ownership after a crash.
RUN apt-get update && apt-get install -y --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    API_PORT=8787 \
    WEB_ORIGIN=http://localhost:5173 \
    LOCAL_DATA_DIR=/app/.data \
    WEBPUSH_ENV_FILE=/app/.data/config/.env
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=build /app/apps/dashboard/package.json ./apps/dashboard/package.json
COPY --from=build /app/apps/functions/package.json ./apps/functions/package.json
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/adapters/package.json ./packages/adapters/package.json
COPY .env.example ./.env.example
RUN mkdir -p .data/config && cp .env.example .data/config/.env.example \
    && chown -R node:node .data && chmod 700 .data .data/config
USER node
EXPOSE 5173
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
    CMD ["node", "dist/tools/container-health.js"]
ENTRYPOINT ["flock", "--exclusive", "--nonblock", "--no-fork", "/app/.data/container.lock"]
CMD ["node", "dist/tools/container.js"]
