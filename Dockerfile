# 适用于任何能跑 Docker 的主机（云主机 / 本地 / K8s）
# 构建：docker build -t littleq .
# 运行：docker run -p 80:80 --env-file .env.local -v littleq-data:/app/.data littleq
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=80 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# 没配 DATABASE_URL 时用内置 PGlite，数据落在这里（请挂卷持久化）
RUN mkdir -p /app/.data
VOLUME ["/app/.data"]
EXPOSE 80
CMD ["node", "server.js"]
