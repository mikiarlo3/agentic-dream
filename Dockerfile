# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The optional npm_ca secret supports corporate/sandbox proxies that intercept
# TLS: docker build --secret id=npm_ca,src=/path/to/ca.pem . In normal
# environments it is absent and this is a plain npm ci.
RUN --mount=type=secret,id=npm_ca \
    sh -c 'if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm_config_cafile=/run/secrets/npm_ca; fi; npm ci --ignore-scripts'
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--no-warnings=ExperimentalWarning \
    DREAM_STORE_DIR=/data/dream-store \
    PORT=8082
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca \
    sh -c 'if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm_config_cafile=/run/secrets/npm_ca; fi; npm ci --omit=dev --ignore-scripts && npm cache clean --force'
COPY --from=build /app/dist ./dist
COPY ui ./ui
EXPOSE 8082
VOLUME /data
CMD ["node", "dist/server.js"]
