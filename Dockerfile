FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV PORT=7001
ENV CONFIG_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 7001

CMD ["node", "index.js"]
