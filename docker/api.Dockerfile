# API: Hono webhooks + admin + panel. No media. Build context: the repo root.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
ENV SAYBEST_ROOT=/app
COPY tsconfig.json ./
COPY prompts prompts
COPY schemas schemas
COPY data data
COPY templates templates
COPY drizzle drizzle
COPY scripts scripts
COPY src src
USER node
CMD ["sh", "-c", "npx tsx scripts/migrate.ts && exec npx tsx src/api/main.ts"]
