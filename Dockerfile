# Collaborative code editor — single-container deploy (HTTP + WebSocket on one port).
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:web

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# The platform injects PORT (Render/Railway/Fly); 9000 is the local default.
EXPOSE 9000
CMD ["node", "dist/server/main.js"]
