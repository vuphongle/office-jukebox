# Event music system — runs on Bun.
FROM oven/bun:1.3.4-alpine

WORKDIR /app

# Install dependencies first so the Docker layer cache can be reused.
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Application source.
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=45416
EXPOSE 45416

CMD ["bun", "server.js"]
