# --- Build stage ---
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

# --- Production stage ---
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# GH #796: the node:22-alpine base ships no zoneinfo DB, so a `TZ=America/...`
# env var can't be resolved and musl silently falls back to UTC. Install tzdata
# (as root, before the USER switch below) so the documented TZ env var works.
# ~3MB; the container stays UTC unless TZ is set.
RUN apk add --no-cache tzdata

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone server and dependencies
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Copy static assets and pre-rendered pages
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Ship the AGPL license text in the image so the distributed container conveys
# the license that package.json declares, per AGPL §1.
COPY --from=builder --chown=nextjs:nodejs /app/LICENSE ./LICENSE

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
