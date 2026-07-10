# Next.js standalone image for npiradar (compose + Traefik labels live in ~/projects/npiradar).
# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Copy only what the Next build needs — the pipeline/ and data/ dirs are excluded via .dockerignore.
COPY package.json next.config.mjs tsconfig.json next-env.d.ts ./
COPY app ./app
COPY lib ./lib
COPY public ./public
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
# Standalone output bundles a minimal server + only the deps it traces (pg included via serverExternalPackages).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# ISR + unstable_cache write here at runtime; the standalone copy is root-owned, so make it writable.
RUN mkdir -p .next/cache && chown -R nextjs:nodejs .next
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
