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

Workflow `.github/workflows/sync.yml` каждый день забирает тренировки и пушит их в репозиторий `workout`.

Секреты репозитория `parse-workout` (Settings → Secrets and variables → Actions):

| Secret | Зачем |
| --- | --- |
| `XIAOMI_USER_ID` | cookie `userId` |
| `XIAOMI_PASS_TOKEN` | cookie `passToken` |
| `WORKOUT_TOKEN` | fine-grained PAT с правом Contents: Read and write на репозиторий `workout` |
| `XIAOMI_REGION` | необязательно, по умолчанию `ru` |
| `XIAOMI_TIMEZONE` | необязательно, по умолчанию `Europe/Moscow` |
| `WORKOUT_REPO` | необязательно, по умолчанию `<github-user>/workout` |

`passToken` и PAT нельзя коммитить в git: они живут только в GitHub Secrets.
