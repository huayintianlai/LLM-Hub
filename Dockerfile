FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

ENV NODE_ENV=production

EXPOSE 4000 4105 4106 4107 8080

CMD ["node", "gateway.mjs"]
