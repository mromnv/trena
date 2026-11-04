FROM node:22-alpine
WORKDIR /app

COPY apps/server/package.json apps/server/package-lock.json* ./apps/server/
RUN cd apps/server && npm install --omit=dev

COPY apps/server ./apps/server
COPY apps/web ./apps/web

RUN mkdir -p /app/data

ENV PORT=8765 MODE=cloud
EXPOSE 8765
# Том данных подключайте в Railway: Settings → Volumes → /app/data
# (инструкция VOLUME в Dockerfile на Railway запрещена)

CMD ["node", "apps/server/src/index.js"]
