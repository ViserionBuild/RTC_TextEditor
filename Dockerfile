# One image: the relay (WebSocket + REST + SQLite) also serves the built web app.

FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @collabpad/web build
# Production-only copy of the relay with its workspace dependencies.
RUN pnpm --filter @collabpad/relay deploy --prod /out \
 && cp -r apps/web/dist /out/web

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_PATH=/data/collabpad.sqlite \
    WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out .
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]
