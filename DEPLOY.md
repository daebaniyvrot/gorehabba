# Деплой «Гарехаббы», саар

Один контейнер раздаёт и игру, и мультиплеер (WebSocket на `/ws`).

## Запуск

```bash
docker compose up -d --build
```

Игра будет на `http://<хост>:8137`. Проверка живости: `curl http://<хост>:8137/healthz` → `ok`.

## Сменить порт

В `docker-compose.yml` поменяйте левую часть маппинга — например, наружу 8080:

```yaml
    ports:
      - "8080:8137"
```

Внутренний порт (8137) трогать не нужно. Затем `docker compose up -d`.

## Логи

```bash
docker compose logs -f
```

Там видно join/leave игроков и число саар онлайн.

## Обновление

Подтяните свежие файлы игры (git pull или копированием), затем:

```bash
docker compose up -d --build
```

## Остановка

```bash
docker compose down
```

## Без Docker (на всякий случай)

```bash
npm ci --omit=dev
PORT=8137 node server/server.js
```

Нужен Node 20+. Всё, хорошего фестиваля, саар! 🎉
