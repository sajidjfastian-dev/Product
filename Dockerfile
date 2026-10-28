FROM node:24-alpine AS api-build
WORKDIR /src
COPY NodeApi/package.json NodeApi/package-lock.json ./
RUN npm ci
COPY NodeApi/ ./
RUN npm run build

FROM node:24-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY NodeApi/package.json NodeApi/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=api-build /src/dist ./dist
EXPOSE 8080
CMD ["node", "dist/server.js"]

FROM node:24-alpine AS web-build
WORKDIR /src
COPY SampleWeb/ClientApp/package.json SampleWeb/ClientApp/package-lock.json ./
RUN npm ci
COPY SampleWeb/ClientApp/ ./
RUN npm run build

FROM node:24-alpine AS web
WORKDIR /app
ENV NODE_ENV=production
COPY SampleWeb/ClientApp/package.json SampleWeb/ClientApp/package-lock.json ./
RUN npm ci --omit=dev
COPY SampleWeb/ClientApp/server.mjs ./
COPY --from=web-build /src/dist ./dist
EXPOSE 8081
CMD ["node", "server.mjs"]
