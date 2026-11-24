FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    WSS_HOST=0.0.0.0 \
    WSS_PORT=3000 \
    WSS_DB=/data/world-souk.sqlite

RUN install -d -o node -g node -m 0700 /data
COPY package.json ./
COPY src/ ./src/
COPY db/ ./db/
COPY public/ ./public/
COPY scripts/backup.mjs ./scripts/backup.mjs

USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.WSS_PORT+'/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server.mjs"]
