# parse-workout

Парсер тренировок из облака Xiaomi Fitness и Garmin Connect. Забирает GPS-треки и кладёт **только GPX** в репозиторий `workout`.

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
| `XIAOMI_USER_ID` | числовой userId, чтобы Actions входили без повторного SMS |
| `XIAOMI_PASS_TOKEN` | сессия Xiaomi для GitHub Actions |
| `XIAOMI_REGION` | необязательно, по умолчанию `de` |
| `XIAOMI_TIMEZONE` | необязательно, по умолчанию `Asia/Yekaterinburg` |
| `WORKOUT_REPO` | необязательно, по умолчанию `<github-user>/workout` |

Пароль нельзя коммитить в git.

## Garmin Connect

Необязательно: если секрета `GARMIN_API_KEY` нет, шаг пропускается, а сбой Garmin не мешает публикации файлов Xiaomi.

Используется официальный [Garmin Connect Personal API](https://github.com/garmin/connect-personal-api-python) (только чтение). Ключ создаётся в Garmin Connect: Настройки → Личный API-ключ; живёт до года, потом его нужно пересоздать и обновить секрет.

| Secret | Зачем |
| --- | --- |
| `GARMIN_API_KEY` | личный API-ключ Garmin Connect |

Garmin отдаёт оригинальный FIT в ZIP; парсер сам распаковывает его и собирает GPX. Файлы называются `<дата>_<время UTC>_<тип>_garmin.gpx`, в них пульс, высота и каденс по точкам (для бега каденс в шагах в минуту, как у Xiaomi). Забираются тренировки за последние 60 дней (`GARMIN_LOOKBACK_DAYS`).

Если одну пробежку записали и Garmin, и Xiaomi (старт отличается не больше чем на 3 минуты), остаётся файл Garmin: копия Xiaomi не публикуется, а уже опубликованная удаляется из `workout`.