FROM node:22-slim

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci && chown -R node:node /app/node_modules

COPY --chown=node:node . .

USER node

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host"]
