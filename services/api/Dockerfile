# Build context must be the REPO ROOT, not services/api — this is an npm
# workspaces monorepo (root package.json + a single package-lock.json cover
# every workspace), so the lockfile and root manifest have to be present to
# install this workspace's deps correctly.
#
# Example (from repo root):
#   docker build -f services/api/Dockerfile -t auctionx-api .

FROM node:20-alpine AS base
WORKDIR /app

# Copy only what `npm ci` needs first, so this layer is cached across
# rebuilds that only change application source, not dependencies.
COPY package.json package-lock.json ./
COPY services/api/package.json ./services/api/package.json
# -w scopes the install to this workspace's dependency tree (npm >=9) —
# apps/web's much heavier Next.js/React deps never get installed into this
# image, while still resolving against the one shared package-lock.json.
RUN npm ci -w services/api

COPY services/api ./services/api
WORKDIR /app/services/api
# Prisma's generated client is derived from schema.prisma, not committed —
# must run before `tsc`, since generated-client types are imported
# throughout src/.
RUN npx prisma generate
RUN npm run build

# --- Runtime stage: only the compiled output + production deps, nothing
# TypeScript/dev-only (ts-node, eslint, @types/*, jest) ships in the final
# image.
#
# Keeps the SAME /app root + services/api subfolder layout as the base
# stage — npm workspaces hoists nearly everything to the top-level
# /app/node_modules (confirmed: services/api/node_modules doesn't exist at
# all after `npm ci -w services/api`), and Node's module resolution walks
# up parent directories looking for node_modules, so dist/server.js can
# only find its dependencies if that same root-relative structure is
# preserved here too.
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/services/api/dist ./services/api/dist
COPY --from=base /app/services/api/prisma ./services/api/prisma
COPY --from=base /app/services/api/package.json ./services/api/package.json

# Migrations are applied as a separate release-phase step (`npx prisma
# migrate deploy`), not baked into the image's own boot — see the
# deployment ADR for why (a web process shouldn't race itself to run
# migrations on every scale-up/restart).
EXPOSE 4000
CMD ["node", "services/api/dist/server.js"]
