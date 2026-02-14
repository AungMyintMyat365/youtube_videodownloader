require('dotenv').config();
const express = require('express');
const ytdl = require('ytdl-core');
const sanitize = require('sanitize-filename');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// Default request options to avoid 403 from remote (YouTube may block non-browser UAs)
const DEFAULT_REQUEST_OPTIONS = {
  headers: {
    'User-Agent': process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
  }
};

app.use(helmet());
app.use(express.static(path.join(__dirname, 'public')));

// Simple rate limiter for API endpoints
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
app.use('/api/', apiLimiter);

// SSE progress connections
const sseMap = new Map(); // requestId -> res

app.get('/api/progress', (req, res) => {
  const requestId = req.query.requestId;
  if (!requestId) return res.status(400).end('missing requestId');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  sseMap.set(requestId, res);

  req.on('close', () => {
    sseMap.delete(requestId);
  });
});

// Formats endpoint: returns available formats (itag, container, qualityLabel, audioBitrate, hasVideo, hasAudio, approx size if available)
app.get('/api/formats', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl || !ytdl.validateURL(videoUrl)) {
    return res.status(400).json({ error: 'Invalid or missing YouTube URL' });
  }
  try {
    const info = await ytdl.getInfo(videoUrl, { requestOptions: DEFAULT_REQUEST_OPTIONS });
    const fmts = info.formats
      .filter(f => f.container && (f.hasVideo || f.hasAudio))
      .map(f => ({
        itag: f.itag,
        container: f.container,
        qualityLabel: f.qualityLabel || null,
        bitrate: f.bitrate || null,
        audioBitrate: f.audioBitrate || null,
        hasVideo: !!f.hasVideo,
        hasAudio: !!f.hasAudio,
        contentLength: f.contentLength || null
      }))
      // sort: prefer video+audio, then by qualityLabel desc
      .sort((a, b) => {
        if ((a.hasVideo && a.hasAudio) && !(b.hasVideo && b.hasAudio)) return -1;
        if ((b.hasVideo && b.hasAudio) && !(a.hasVideo && a.hasAudio)) return 1;
        const qa = a.qualityLabel || '';
        const qb = b.qualityLabel || '';
        return qb.localeCompare(qa, undefined, { numeric: true });
      });

    res.json({ formats: fmts });
  } catch (err) {
    console.error('formats error', err && err.stack ? err.stack : err);
    try {
      const logDir = path.join(__dirname, 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, 'errors.log'), `[${new Date().toISOString()}] formats error: ${err && err.stack ? err.stack : err}\n`);
    } catch (e) {
      // ignore file write errors
    }
    res.status(500).json({ error: 'Failed to get formats', message: err && err.message });
  }
});

// Download endpoint: /api/download?url=...&type=video&requestId=...
app.get('/api/download', async (req, res) => {
  const videoUrl = req.query.url;
  const type = req.query.type || 'video';
  const requestId = req.query.requestId;

  // Optional API key enforcement
  const API_KEY = process.env.API_KEY;
  if (API_KEY) {
    const provided = req.headers['x-api-key'] || req.query.api_key;
    if (!provided || provided !== API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!videoUrl || !ytdl.validateURL(videoUrl)) {
    return res.status(400).json({ error: 'Invalid or missing YouTube URL' });
  }

  try {
    const info = await ytdl.getInfo(videoUrl);
    const title = sanitize((info.videoDetails && info.videoDetails.title) || 'video');
    const formatExt = type === 'audio' ? 'mp3' : 'mp4';
    const filename = `${title}.${formatExt}`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    let filter;
    if (type === 'audio') {
      filter = (format) => format.audioBitrate && !format.hasVideo;
    } else {
      filter = (format) => format.container === 'mp4' && format.hasVideo;
    }

    // If a specific itag was requested, choose that format to stream
    let stream;
    if (req.query.itag) {
      const chosen = ytdl.chooseFormat(info.formats, { quality: req.query.itag });
      if (chosen && chosen.itag) {
        stream = ytdl(videoUrl, { format: chosen, requestOptions: DEFAULT_REQUEST_OPTIONS });
      } else {
        // fallback
        stream = ytdl(videoUrl, { quality: 'highest', filter, requestOptions: DEFAULT_REQUEST_OPTIONS });
      }
    } else {
      stream = ytdl(videoUrl, { quality: 'highest', filter, requestOptions: DEFAULT_REQUEST_OPTIONS });
    }

    // Forward ytdl progress to SSE connection if available
    stream.on('progress', (chunkLength, downloaded, total) => {
      if (!requestId) return;
      const sseRes = sseMap.get(requestId);
      if (!sseRes) return;
      const pct = total ? Math.round((downloaded / total) * 100) : null;
      const payload = JSON.stringify({ downloaded, total, percent: pct });
      sseRes.write(`data: ${payload}\n\n`);
      if (total && downloaded >= total) {
        sseRes.write('event: done\n');
        sseRes.write('data: {}\n\n');
        sseRes.end();
        sseMap.delete(requestId);
      }
    });

    stream.on('error', (err) => {
      console.error('ytdl error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
      const sseRes = requestId && sseMap.get(requestId);
      if (sseRes) {
        sseRes.write(`event: error\ndata: ${JSON.stringify({ message: 'Download failed' })}\n\n`);
        sseRes.end();
        sseMap.delete(requestId);
      }
      stream.destroy();
    });

    stream.pipe(res);
  } catch (err) {
    console.error('Error fetching video info:', err && err.stack ? err.stack : err);
    // Return more helpful error message to the client for debugging (non-sensitive)
    res.status(500).json({ error: 'Server error fetching video info', message: err && err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
