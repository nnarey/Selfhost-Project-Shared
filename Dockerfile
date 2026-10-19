# Standard-tier Harbor app (SQLite on EFS). Base images from public.ecr.aws — not Docker Hub.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ENV VITE_APPS_SCRIPT_URL=
ENV VITE_LOCAL_API_URL=
ENV VITE_ADMIN_PASSWORD=
ENV VITE_HARBOR_PERMANENT_ONLY=false
RUN npm run build

FROM public.ecr.aws/docker/library/node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ sqlite3 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
COPY --from=web /src/web/dist /app/web/dist
COPY data /app/data
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8080
ENV WEB_DIST=/app/web/dist
ENV DATABASE_PATH=/data/fieldcam.sqlite
ENV SPLUNK_SNAPSHOT_PATH=/app/data/splunk-activity.csv
ENV FLEET_ENABLED=false
ENV FLEET_MODE=off
ENV LEADERBOARD_PERMANENT_ONLY=false
ENV HARBOR_TRUST_IDENTITY=true
# Must match SEASON_START (server/src/config/season.ts). Harbor has no environment-variable UI,
# so this baked-in value is the only thing that sets the period grid on the deployed site.
ENV COMPETITION_START=2026-08-31
EXPOSE 8080

CMD ["npx", "tsx", "src/index.ts"]
