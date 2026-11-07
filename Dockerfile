FROM node:22-alpine
WORKDIR /app

COPY apps/server/package.json apps/server/package-lock.json* ./apps/server/
RUN cd apps/server && npm install --omit=dev

COPY apps/server ./apps/server
COPY apps/web ./apps/web

RUN mkdir -p /app/data

ENV MODE=cloud
# Том Railway должен быть смонтирован сюда, иначе база обнуляется при каждом деплое
ENV DATA_DIR=/app/data
# Фиксируем порт — в Railway Networking укажите тот же: 8000
ENV PORT=8000
EXPOSE 8000
# Том: Settings → Volumes → /app/data

CMD ["node", "apps/server/src/index.js"]
