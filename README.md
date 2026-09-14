# parse-workout

Парсер тренировок из облака Xiaomi Fitness (`Mi Fitness` / `mi.health`). Данные пишет в отдельный репозиторий `workout`.

## Локальный запуск

1. Скопируйте `.env.example` в `.env` и заполните `XIAOMI_USER_ID` и `XIAOMI_PASS_TOKEN`.
2. Как получить cookie:
   - откройте [account.xiaomi.com](https://account.xiaomi.com) и войдите;
   - DevTools → Application → Cookies → `account.xiaomi.com`;
   - скопируйте `userId` и `passToken`.
3. Запуск:

```bash
npm test
node src/cli.js --out ./out
```

Регион по умолчанию `ru`. Если аккаунт в другом регионе, задайте `XIAOMI_REGION` (`cn`, `de`, `sg`, `us`, `i2`). Парсер сам переберёт известные регионы, если выбранный не ответит.

## GitHub Actions

Основной workflow живёт в репозитории `workout`: каждый день он клонирует этот парсер, забирает тренировки и коммитит JSON обратно в `workout`. Секреты кладите туда же (Settings → Secrets and variables → Actions), чтобы они не попали в публичный код.

| Secret | Зачем |
| --- | --- |
| `XIAOMI_USER_ID` | cookie `userId` |
| `XIAOMI_PASS_TOKEN` | cookie `passToken` |
| `XIAOMI_REGION` | необязательно, по умолчанию `ru` |
| `XIAOMI_TIMEZONE` | необязательно, по умолчанию `Europe/Moscow` |

В этом репозитории тоже есть `.github/workflows/sync.yml`, если нужно пушить в `workout` отсюда. Для этого дополнительно нужен `WORKOUT_TOKEN` (fine-grained PAT с Contents: Read and write на `workout`).

`passToken` нельзя коммитить в git: только GitHub Secrets.
