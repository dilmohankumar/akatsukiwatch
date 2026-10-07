FROM node:22-alpine AS web
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server ./
COPY --from=web /app/client/dist ../client/dist
ENV PORT=4100
EXPOSE 4100
CMD ["node", "src/index.js"]
