# Production image: one container serving the Express API and the built React app from the same
# origin. Build context is the repository root.
#
#   docker build -t aop-app .
#   docker run --env-file .env -e NODE_ENV=production -p 4000:4000 aop-app

# ---- Build stage: install all dependencies, compile packages and the API, bundle the web app --
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/validation/package.json packages/validation/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY packages packages
COPY apps/api apps/api
COPY apps/web apps/web
# Workspace packages first: the API and web builds consume their compiled output.
RUN npm run build -w @aop/validation \
 && npm run build -w @aop/web \
 && npm run build -w @aop/api

# ---- Runtime stage: production dependencies and build output only ---------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    WEB_DIST_DIR=/app/apps/web/dist
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/validation/package.json packages/validation/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev -w @aop/api -w @aop/validation --include-workspace-root=false \
 && npm cache clean --force

COPY --from=build /app/packages/validation/dist packages/validation/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist

# Run as the unprivileged user that ships with the Node image.
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]
