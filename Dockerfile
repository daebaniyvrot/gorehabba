# Гарехабба — образ сервера мультиплеера (статика + WebSocket).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Сначала зависимости — слой кешируется.
COPY package*.json ./
RUN npm ci --omit=dev

# Затем всё остальное (фильтрует .dockerignore).
COPY . .

ENV PORT=8137
EXPOSE 8137

USER node
CMD ["node", "server/server.js"]
