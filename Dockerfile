# M9 (ADR-051): platform-agnostic production image. Node 24 alpine (ADR-014), non-root,
# production dependencies only, and a direct `node dist/server.js` PID 1 so SIGTERM reaches the
# graceful shutdown (OPS-04). No build tools, dev dependencies, or source in the runtime stage.
ARG NODE_IMAGE=node:24-alpine

# Stage 1: production dependencies. Build tools stay in this stage: bcrypt compiles a native
# addon and its prebuilds do not cover every musl target.
FROM ${NODE_IMAGE} AS deps
RUN apk add --no-cache python3 make g++
# corepack honors package.json#packageManager (pnpm 12.3.4): no version drift, no global install.
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Stage 2: compile TypeScript. A full install (dev dependencies included) that is discarded after.
FROM ${NODE_IMAGE} AS build
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN pnpm build

# Stage 3: the runtime. Only package.json (for `npm`-level introspection), prod node_modules, and dist/.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN chown -R node:node /app
USER node
EXPOSE 1500
# BusyBox wget (no curl on alpine); ${PORT} honored, 1500 when unset. start-period covers a cold
# database on first boot; the compose file additionally orders on the mongo healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-1500}/health" || exit 1
CMD ["node", "dist/server.js"]
