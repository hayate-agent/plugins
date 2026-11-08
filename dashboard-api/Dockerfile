FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY agent-link/package.json agent-link/package-lock.json ./agent-link/
RUN npm ci --prefix agent-link --include=dev --ignore-scripts
COPY agent-link/scripts ./agent-link/scripts
RUN npm run build --prefix agent-link

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node LICENSE ./LICENSE
COPY --chown=node:node shared ./shared
COPY --chown=node:node credentials ./credentials
COPY --chown=node:node identity ./identity
COPY --chown=node:node workspace ./workspace
COPY --chown=node:node agent-hub ./agent-hub
COPY --chown=node:node agent-link ./agent-link
COPY --from=build --chown=node:node /build/agent-link/vendor ./agent-link/vendor
COPY --chown=node:node dashboard-api ./dashboard-api
USER node
EXPOSE 3211
CMD ["node", "dashboard-api/standalone.mjs"]
