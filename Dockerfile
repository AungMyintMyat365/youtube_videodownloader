FROM node:18-alpine

WORKDIR /usr/src/app

# Install app dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Install python3 and yt-dlp so the container has yt-dlp available as a binary
RUN apk add --no-cache python3 py3-pip ca-certificates && \
	python3 -m pip install --upgrade pip setuptools wheel && \
	pip3 install --no-cache-dir yt-dlp && \
	# ensure yt-dlp is on PATH
	if [ -x "/usr/local/bin/yt-dlp" ]; then ln -sf /usr/local/bin/yt-dlp /usr/bin/yt-dlp || true; fi

# Copy app source
COPY . .

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server.js"]
