FROM node:18-alpine

WORKDIR /usr/src/app

# Install app dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy app source
COPY . .

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server.js"]
