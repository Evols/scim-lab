# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./


FROM base AS dependencies

RUN pnpm install --frozen-lockfile


FROM dependencies AS build

COPY . .

RUN pnpm build


FROM dependencies AS migrator

COPY drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src/db ./src/db

CMD ["pnpm", "db:migrate"]


FROM base AS production-dependencies

RUN pnpm install --prod --frozen-lockfile


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node scripts ./scripts

USER node

EXPOSE 4321

CMD ["node", "./dist/server/entry.mjs"]
