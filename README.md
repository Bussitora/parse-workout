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

Необязательно: если Garmin-секретов нет, шаг пропускается, а сбой Garmin не мешает публикации файлов Xiaomi.

Garmin часто блокирует вход по паролю с серверов GitHub и может спросить код MFA, поэтому токен получают один раз локально:

```bash
node src/garmin-login.js
```

Скрипт спросит email, пароль и при необходимости код MFA (или возьмёт `GARMIN_USERNAME`/`GARMIN_PASSWORD` из `.env`) и напечатает строку — её нужно сохранить в секрет `GARMIN_TOKEN`. Токен живёт около года; когда истечёт, шаг Garmin упадёт с `OAuth2 exchange failed` — просто повторите вход.

| Secret | Зачем |
| --- | --- |
| `GARMIN_TOKEN` | OAuth1-токен из `src/garmin-login.js` (рекомендуется) |
| `GARMIN_USERNAME`, `GARMIN_PASSWORD` | запасной вход по паролю, если токена нет |

Файлы Garmin называются `<дата>_<время UTC>_<тип>_garmin.gpx`, в них пульс, высота и каденс по точкам. Забираются тренировки за последние 60 дней (`GARMIN_LOOKBACK_DAYS`).

Если одну пробежку записали и Garmin, и Xiaomi (старт отличается не больше чем на 3 минуты), остаётся файл Garmin: копия Xiaomi не публикуется, а уже опубликованная удаляется из `workout`.

Вход повторяет схему библиотеки [garth](https://github.com/matin/garth): у Garmin нет официального API для частных лиц, так что после изменений на их стороне вход может перестать работать.
