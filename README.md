# parse-workout

Парсер тренировок из облака Xiaomi Fitness. Забирает GPS-треки и кладёт **только GPX** в репозиторий `workout`.

Логин — email/телефон и пароль Xiaomi, без cookie. Секреты хранятся в этом репозитории: Settings → Secrets and variables → Actions.

## Локальный запуск

1. Скопируйте `.env.example` в `.env`.
2. Заполните `XIAOMI_USERNAME` и `XIAOMI_PASSWORD`.
3. Запуск:

```bash
npm test
node src/cli.js --out ./out
```

Регион по умолчанию `de` (Германия). При необходимости задайте `XIAOMI_REGION` (`ru`, `cn`, `sg`, `us`, `i2`).

Если Xiaomi потребует captcha или SMS, автоматический вход не завершится — это ограничение облака, не парсера.

## GitHub Actions

Каждый день workflow забирает тренировки и пушит GPX в `workout`.

| Secret | Зачем |
| --- | --- |
| `XIAOMI_USERNAME` | email или телефон аккаунта Xiaomi |
| `XIAOMI_PASSWORD` | пароль Xiaomi |
| `WORKOUT_TOKEN` | fine-grained PAT с Contents: Read and write на репозиторий `workout` |
| `XIAOMI_REGION` | необязательно, по умолчанию `de` |
| `XIAOMI_TIMEZONE` | необязательно, по умолчанию `Europe/Berlin` |
| `WORKOUT_REPO` | необязательно, по умолчанию `<github-user>/workout` |

Пароль нельзя коммитить в git.
