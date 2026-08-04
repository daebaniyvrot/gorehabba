#!/usr/bin/env bash
# Прод-репетиция «Гарехаббы»: собираем образ (если надо), поднимаем стек
# «приложение за nginx-прокси» (реплика боевого v1nce.conf, префикс /fest)
# и гоняем tests/prod/prodlike.test.js ЧЕРЕЗ прокси — как ходят игроки.
#
# Использование: bash tests/prod/run.sh
#   IMAGE=ghcr.io/…:tag — тестировать готовый образ из реестра (будет docker pull;
#                         default garehabba:prod-test — собирается локально)
#   FORCE_BUILD=1       — пересобрать образ, даже если он уже есть
#   PROXY_PORT=…        — порт прокси на хосте (default 8180)
#   PROD_BASE=…         — база для тестов (default http://localhost:$PROXY_PORT/fest)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/tests/prod/docker-compose.prod-test.yml"
export IMAGE="${IMAGE:-garehabba:prod-test}"
export PROXY_PORT="${PROXY_PORT:-8180}"
BASE="${PROD_BASE:-http://localhost:${PROXY_PORT}/fest}"

# Образ: локальное имя (garehabba:prod-test) — строим при отсутствии;
# реестровая ссылка (содержит «/») — только pull, чтобы случайно не протестировать
# свежесобранное рабочее дерево под видом готового образа из реестра.
if [ "${FORCE_BUILD:-0}" = "1" ]; then
  echo "[prod-test] собираем образ $IMAGE (FORCE_BUILD=1)…"
  docker build -t "$IMAGE" "$ROOT"
elif ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  case "$IMAGE" in
    */*)
      echo "[prod-test] образа $IMAGE нет локально — пуллим из реестра…"
      docker pull "$IMAGE"
      ;;
    *)
      echo "[prod-test] собираем образ $IMAGE…"
      docker build -t "$IMAGE" "$ROOT"
      ;;
  esac
else
  echo "[prod-test] образ $IMAGE уже есть — сборку пропускаем (FORCE_BUILD=1 для пересборки)"
fi

# Что бы ни случилось — стек сносим вместе с volume (идемпотентность прогонов);
# при аварийном выходе сначала показываем логи, иначе они пропадут навсегда.
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[prod-test] прогон упал (код $rc) — логи стека перед сносом:" >&2
    docker compose -f "$COMPOSE_FILE" logs >&2 || true
  fi
  echo "[prod-test] сносим стек…"
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[prod-test] поднимаем стек (garehabba за nginx-прокси)…"
docker compose -f "$COMPOSE_FILE" up -d --wait

# Ждём готовности ЧЕРЕЗ прокси — ровно тем путём, которым пойдут игроки.
echo "[prod-test] ждём готовности $BASE/healthz…"
deadline=$(( $(date +%s) + 60 ))
until [ "$(curl -fsS "$BASE/healthz" 2>/dev/null || true)" = "ok" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[prod-test] стек не ответил ok за 60 с; логи стека:" >&2
    docker compose -f "$COMPOSE_FILE" logs >&2 || true
    exit 1
  fi
  sleep 1
done

echo "[prod-test] гоняем прод-тесты через прокси…"
PROD_BASE="$BASE" node --test "$ROOT/tests/prod/prodlike.test.js"
