# Single stage on purpose. The signalling server is plain Node with one
# dependency and nothing to compile, so a builder stage would only add a layer.
FROM node:22-alpine

WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./

# Binds 0.0.0.0 inside the container. The loopback restriction is the port
# mapping in compose, not the bind address.
ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/config.json > /dev/null || exit 1

CMD ["node", "index.js"]
