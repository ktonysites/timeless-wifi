# Works on Koyeb, Fly.io, Railway, Google Cloud Run, or any VPS with Docker.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js packages.js ./
COPY public ./public
COPY scripts ./scripts
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "server.js"]
