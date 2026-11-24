# ---- build: compile TypeScript server + bundle client assets ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY client ./client
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:24-alpine
# git powers GovDocs (one repository per policy document).
RUN apk add --no-cache git tini
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY views ./views
COPY db ./db
COPY public ./public

# GovDocs git repos live on a volume.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
