FROM node:22-alpine
WORKDIR /app

COPY apps/server/package.json apps/server/package-lock.json* ./apps/server/
RUN cd apps/server && npm install --omit=dev

COPY apps/server ./apps/server
COPY apps/web ./apps/web

RUN mkdir -p /app/data

ENV MODE=cloud
# PORT задаёт Railway сам — не фиксируем 8765
EXPOSE 8080
# Том: Settings → Volumes → /app/data

CMD ["node", "apps/server/src/index.js"]
