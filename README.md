# YouTube Video Downloader (Simple)

This is a minimal, high-quality example of a YouTube downloader using Node.js, Express and ytdl-core.

Features:

How to run:

1. Install dependencies:

```bash
npm install
```

2. (Optional) Create a `.env` file and set PORT if desired.

3. Start the server:

```bash
npm start
```

4. Open http://localhost:3000

Notes:

Docker

Build and run with Docker:

```bash
docker build -t yt-downloader .
docker run -p 3000:3000 --rm yt-downloader
```
