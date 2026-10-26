# Гарехабба — образ сервера мультиплеера (статика + WebSocket).
# Пин точной версии: секьюрити-релиз Node 22.23.4 (20.10.2026, 10 CVE,
# в т.ч. RCE через Brotli). Следующий патч Node = бамп этой строки через PR.
FROM node:22.23.4-alpine

WORKDIR /app
ENV NODE_ENV=production

# Сначала зависимости — слой кешируется.
COPY package*.json ./
RUN npm ci --omit=dev

# Затем всё остальное (фильтрует .dockerignore).
COPY . .

ENV PORT=8137
EXPOSE 8137

# Каталог для очков: сюда монтируется volume, node должен уметь писать.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
CMD ["node", "server/server.js"]
