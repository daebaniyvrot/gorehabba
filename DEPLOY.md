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

## Обновление через git

Если сервер — это git-клон репозитория (рекомендуемый способ), обновление в одну строчку:

```bash
git pull && docker compose up -d --build garehabba
```

Compose пересоберёт образ и перезапустит контейнер только если что-то поменялось.

Очки игроков (скорборд) живут в named volume `garehabba-data` (внутри контейнера —
`/app/data/scores.json`), поэтому пересборка и перезапуск их **не трогают**: данные
переживают любое обновление. Удалятся они только по явному `docker compose down -v`
(флаг `-v` сносит volumes — без нужды не используйте).

Если файлы попали на сервер не через git (копированием) — просто выполните ту же
команду без `git pull`:

```bash
docker compose up -d --build
```

## Деплой из готового образа (GHCR)

Каждый релиз (экшен «Релиз» в GitHub Actions) публикует мультиарх-образ
(amd64 + arm64) в GitHub Container Registry:

- `ghcr.io/daebaniyvrot/gorehabba:latest` — последний релиз;
- `ghcr.io/daebaniyvrot/gorehabba:1.1.0` — конкретная версия (тег без `v`).

Тогда на сервере не нужны ни git-клон, ни сборка — в `docker-compose.yml`
вместо `build: .` указывается `image`:

```yaml
services:
  garehabba:
    image: ghcr.io/daebaniyvrot/gorehabba:latest
    ports:
      - "8137:8137"
    restart: unless-stopped
    environment:
      PORT: "8137"
      SCORES_FILE: /app/data/scores.json
    volumes:
      - garehabba-data:/app/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8137/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s

volumes:
  garehabba-data:
```

Обновление на свежий релиз:

```bash
docker compose pull && docker compose up -d
```

Очки в volume `garehabba-data` при этом, как и раньше, не трогаются.

**Про видимость пакета:** первый пуш в GHCR создаёт пакет **приватным**. Либо
включите ему Public в настройках пакета на GitHub (страница пакета →
Package settings → Change visibility), либо залогиньтесь на сервере:

```bash
docker login ghcr.io -u <github-логин>   # пароль — PAT со scope read:packages
```

Старый способ — сборка из git-клона (`git pull && docker compose up -d --build`) —
продолжает работать, образ из GHCR его не отменяет.

**Если релиз упал на полпути** (тег создан, а Release/образ — нет): просто
перезапустите «Релиз» с той же версией — воркфлоу идемпотентный и допустит
повтор, если тег указывает на тот же коммит.

## За обратным прокси (nginx и т.п.)

Если игра живёт на сабпути за прокси (как боевой `v1nce.me/fest/`), в сервис
нужно добавить `TRUST_PROXY: "1"` — тогда rate-limit скорборда берёт IP игрока
из последнего hop'а `X-Forwarded-For`, который дописывает ваш прокси:

```yaml
        environment:
            PORT: "8137"
            SCORES_FILE: /app/data/scores.json
            TRUST_PROXY: "1"   # ТОЛЬКО за прокси! Без прокси заголовок спуфится
```

Прокси обязан слать `X-Forwarded-For` и WebSocket-Upgrade — рабочий пример
конфига: [tests/prod/nginx.conf](tests/prod/nginx.conf) (это реплика боевого,
её же гоняет прод-репетиция `npm run test:prod`).

## Остановка

```bash
docker compose down
```

## Без Docker (на всякий случай)

```bash
npm ci --omit=dev
PORT=8137 node server/server.js
```

Нужен Node 20+. Очки скорборда лягут в `./data/scores.json`
(путь можно переопределить через env `SCORES_FILE`).

Всё, хорошего фестиваля, саар! 🎉
