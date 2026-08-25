# Hệ thống âm nhạc sự kiện — chạy trên Bun.
FROM oven/bun:1-alpine

WORKDIR /app

# Cài dependency trước (tận dụng cache của layer tốt hơn).
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Mã nguồn ứng dụng.
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=45416
EXPOSE 45416

CMD ["bun", "server.js"]
