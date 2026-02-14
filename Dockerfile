FROM node:18-alpine

WORKDIR /usr/src/app

# Install app dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Install python3 and yt-dlp so the container has yt-dlp available as a binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ca-certificates ffmpeg ca-certificates && \
    python3 -m pip install --upgrade pip setuptools wheel && \
    pip3 install --no-cache-dir yt-dlp && \
    rm -rf /var/lib/apt/lists/*

# Copy app source
COPY . .

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server.js"]
