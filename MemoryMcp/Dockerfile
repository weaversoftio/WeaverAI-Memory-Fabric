# memory-mcp: MCP server giving coding agents read/write access to Agent Memory.
# Stateless; holds no secrets (each request carries the caller's own sk-mem key).

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# Defaults for the WeaverAI Memory Fabric panel address and instance, overridable with -e at run time.
# The WAIP MCP store can't set env vars, so its image bakes the in-cluster hub address in:
#   --build-arg MEMORY_HUB_URL=http://agent-memory-hub.apps.svc.cluster.local:8125
ARG MEMORY_HUB_URL=http://127.0.0.1:8125
ARG MEMORY_SERVICE_ID=default
ENV NODE_ENV=production \
    PORT=8080 \
    MEMORY_HUB_URL=$MEMORY_HUB_URL \
    MEMORY_SERVICE_ID=$MEMORY_SERVICE_ID
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
