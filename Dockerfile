FROM oven/bun:alpine

RUN apk add --no-cache git bash

WORKDIR /app

COPY package.json package-lock.json* bun.lock  ./
RUN bun install

COPY . .
RUN bun install
RUN bun run build

RUN adduser -D -u 1001 telecodex \
  && mkdir -p /workspace /home/telecodex/.codex \
  && chown -R telecodex:telecodex /workspace /home/telecodex

USER telecodex

CMD ["bun", "dist/index.js"]
