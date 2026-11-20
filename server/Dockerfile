FROM node:22-alpine
RUN apk add --no-cache git openssh-client
WORKDIR /app
COPY server.mjs .
USER node
CMD ["node", "server.mjs"]
