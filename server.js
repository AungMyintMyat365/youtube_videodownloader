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
    // Attempt yt-dlp fallback if available
    try {
      const fallback = await getFormatsWithYtDlp(videoUrl);
      if (fallback && fallback.length) return res.json({ formats: fallback, source: 'yt-dlp' });
    } catch (e2) {
      console.error('yt-dlp fallback failed', e2 && e2.stack ? e2.stack : e2);
      try {
        fs.appendFileSync(path.join(__dirname, 'logs', 'errors.log'), `[${new Date().toISOString()}] yt-dlp fallback error: ${e2 && e2.stack ? e2.stack : e2}\n`);
      } catch (e3) {
        // ignore
      }
    }

    res.status(500).json({ error: 'Failed to get formats', message: err && err.message });
  }
});

// Helper: use yt-dlp (external binary) to dump JSON and extract formats
const { execFile } = require('child_process');
function getFormatsWithYtDlp(videoUrl) {
  return new Promise((resolve, reject) => {
    const bin = process.env.YTDLP_BIN || 'yt-dlp';
    // -J outputs full JSON info
    execFile(bin, ['-J', '--no-warnings', videoUrl], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // If binary not found or other error
        return reject(err);
      }
      try {
        const info = JSON.parse(stdout);
        const fmts = (info.formats || [])
          .filter(f => f.ext && (f.acodec !== 'none' || f.vcodec !== 'none'))
          .map(f => ({
            itag: f.format_id || f.format || null,
            container: f.ext || null,
            qualityLabel: f.format_note || f.format || null,
            bitrate: f.tbr || null,
            audioBitrate: f.abr || null,
            hasVideo: f.vcodec && f.vcodec !== 'none',
            hasAudio: f.acodec && f.acodec !== 'none',
            contentLength: f.filesize || f.filesize_approx || null
          }))
          // prefer audio+video
          .sort((a, b) => {
            if ((a.hasVideo && a.hasAudio) && !(b.hasVideo && b.hasAudio)) return -1;
            if ((b.hasVideo && b.hasAudio) && !(a.hasVideo && a.hasAudio)) return 1;
            const qa = a.qualityLabel || '';
            const qb = b.qualityLabel || '';
            return qb.localeCompare(qa, undefined, { numeric: true });
          });
        resolve(fmts);
      } catch (e) {
        reject(e);
      }
    });
  });
}

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
    const info = await ytdl.getInfo(videoUrl, { requestOptions: DEFAULT_REQUEST_OPTIONS });
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

    // Attempt to stream via ytdl-core first
    let streamErrHandled = false;
    const startYtdlStream = () => {
      let stream;
      if (req.query.itag) {
        const chosen = ytdl.chooseFormat(info.formats, { quality: req.query.itag });
        if (chosen && chosen.itag) {
          stream = ytdl(videoUrl, { format: chosen, requestOptions: DEFAULT_REQUEST_OPTIONS });
        } else {
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
        console.error('ytdl error:', err && err.stack ? err.stack : err);
        streamErrHandled = true;
        // attempt yt-dlp fallback
        tryYtDlpFallback();
      });

      stream.pipe(res);
    };

    const tryYtDlpFallback = () => {
      // If headers already sent and stream failed, we can't switch easily
      if (res.headersSent) {
        try { res.end(); } catch (e) {}
        return;
      }
      const bin = process.env.YTDLP_BIN || 'yt-dlp';
      const formatArg = req.query.itag ? [ '-f', req.query.itag ] : (type === 'audio' ? ['-f', 'bestaudio'] : ['-f', 'best'] );
      const args = ['-o', '-', '--no-warnings', '--no-playlist', ...formatArg, videoUrl];
      console.log('spawning yt-dlp', bin, args.join(' '));
      const child = execFile(bin, args, { maxBuffer: 0 }, (err) => {
        if (err) console.error('yt-dlp stream error', err && err.stack ? err.stack : err);
      });

      // Ensure they get attachment headers
      try {
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
      } catch (e) {}

      child.stdout.pipe(res);
      child.stderr.on('data', (d) => console.error('yt-dlp stderr:', d.toString()));
      req.on('close', () => {
        try { child.kill('SIGTERM'); } catch (e) {}
      });
    };

    // Notify usage if configured and running in production/Render (fire-and-forget)
    (function maybeNotify() {
      const webhook = process.env.NOTIFY_WEBHOOK;
      const isProd = process.env.NODE_ENV === 'production' || !!process.env.RENDER_SERVICE_ID || !!process.env.RENDER_REGION;
      if (!webhook || !isProd) return;
      const payload = JSON.stringify({ event: 'download_started', url: videoUrl, type, time: new Date().toISOString(), remote: req.ip || req.connection.remoteAddress });
      try {
        const u = new URL(webhook);
        const lib = u.protocol === 'http:' ? require('http') : require('https');
        const p = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + (u.search || ''), headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (r) => { r.on('data', () => {}); });
        p.on('error', () => {});
        p.write(payload); p.end();
      } catch (e) {
        // ignore notify errors
      }
    })();

    startYtdlStream();
  } catch (err) {
    console.error('Error fetching video info:', err && err.stack ? err.stack : err);
    // Return more helpful error message to the client for debugging (non-sensitive)
    res.status(500).json({ error: 'Server error fetching video info', message: err && err.message });
  }
});

// Dev helper: return recent error log contents for debugging (requires DEBUG_SECRET if set)
app.get('/api/logs', (req, res) => {
  const secret = req.query.secret;
  const required = process.env.DEBUG_SECRET;
  if (required && secret !== required) return res.status(403).json({ error: 'Forbidden' });

  const logPath = path.join(__dirname, 'logs', 'errors.log');
  if (!fs.existsSync(logPath)) return res.status(404).json({ error: 'no logs found' });
  try {
    const data = fs.readFileSync(logPath, 'utf8');
    // return last ~2000 characters to avoid huge responses
    const tail = data.length > 2000 ? data.slice(-2000) : data;
    return res.json({ tail });
  } catch (err) {
    return res.status(500).json({ error: 'failed to read logs', message: err && err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
