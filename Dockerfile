FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4000 HERDR_DB=/data/herdr.db
COPY --from=build /app /app
RUN mkdir -p /data
VOLUME /data
EXPOSE 4000
CMD ["npm", "start"]
