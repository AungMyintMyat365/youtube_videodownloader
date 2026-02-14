const urlInput = document.getElementById('url');
const typeSelect = document.getElementById('type');
const downloadBtn = document.getElementById('download');
const statusDiv = document.getElementById('status');
const fetchFormatsBtn = document.getElementById('fetchFormats');
const formatSelect = document.getElementById('formatSelect');
const autoSelect = document.getElementById('autoSelect');

function setStatus(text, isError = false) {
  statusDiv.textContent = text;
  statusDiv.className = isError ? 'status error' : 'status';
}

// Download using fetch and stream the response so we can show progress.
downloadBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const type = typeSelect.value;

  if (!url) return setStatus('Please enter a YouTube URL', true);

  try {
    setStatus('Preparing download...');
    downloadBtn.disabled = true;

    // Create a unique requestId for SSE
    const requestId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

    // Open SSE to receive progress updates
    const sse = new EventSource(`/api/progress?requestId=${encodeURIComponent(requestId)}`);
    sse.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.percent != null) {
          setStatus(`Downloading: ${data.percent}% (${(data.downloaded / 1024 / 1024).toFixed(2)} MB)`);
        } else {
          setStatus(`Downloading: ${(data.downloaded / 1024 / 1024).toFixed(2)} MB`);
        }
      } catch (err) {
        // ignore
      }
    };
    sse.addEventListener('done', () => {
      setStatus('Download finished.');
      sse.close();
    });
    sse.addEventListener('error', (ev) => {
      // server may send error event
      setStatus('Download error', true);
      sse.close();
    });

    // Start browser download by navigating to the download endpoint (streams to disk, avoids buffering)
    const itag = formatSelect ? formatSelect.value : '';
    const params = new URLSearchParams({ url, type, requestId });
    if (itag) params.set('itag', itag);
    const downloadUrl = `/api/download?${params.toString()}`;
    // Trigger download in new tab (some browsers block downloads from SSE-connected pages if not user gesture)
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.click();

    setStatus('Download started.');
  } catch (err) {
    console.error(err);
    setStatus('Failed to start download: ' + (err.message || err), true);
    downloadBtn.disabled = false;
  }
});

// Fetch formats for the given URL and populate formatSelect
async function fetchFormats() {
  const url = urlInput.value.trim();
  if (!url) return setStatus('Enter a YouTube URL first', true);
  try {
    setStatus('Fetching formats...');
    fetchFormatsBtn.disabled = true;
    const params = new URLSearchParams({ url });
    const resp = await fetch(`/api/formats?${params.toString()}`);
    if (!resp.ok) throw new Error('Failed to fetch formats');
    const json = await resp.json();
    const fmts = json.formats || [];
    // Clear and populate with filters for selected type
    const type = typeSelect.value;
    formatSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Default (auto)';
    formatSelect.appendChild(defaultOpt);
    // Filter formats by requested type: if audio requested, show audio-only + audio+video; if video requested, show video+audio first
    let filtered = fmts.filter(f => {
      if (type === 'audio') return f.hasAudio;
      return f.hasVideo || f.hasAudio;
    });
    // Sort: prefer A+V, then by qualityLabel numeric desc, then audioBitrate
    filtered.sort((a,b) => {
      const aAV = a.hasAudio && a.hasVideo;
      const bAV = b.hasAudio && b.hasVideo;
      if (aAV && !bAV) return -1;
      if (bAV && !aAV) return 1;
      const qa = a.qualityLabel || '';
      const qb = b.qualityLabel || '';
      const cmp = qb.localeCompare(qa, undefined, { numeric: true });
      if (cmp !== 0) return cmp;
      return (b.audioBitrate || 0) - (a.audioBitrate || 0);
    });

    filtered.forEach(f => {
      const opt = document.createElement('option');
      opt.value = String(f.itag);
      const size = f.contentLength ? ` - ${(f.contentLength/1024/1024).toFixed(2)} MB` : '';
      const q = f.qualityLabel ? `${f.qualityLabel}` : (f.hasAudio && !f.hasVideo ? 'audio only' : 'unknown');
      opt.textContent = `${f.itag} • ${q} • ${f.container}${f.hasVideo && f.hasAudio ? ' (A+V)' : f.hasAudio ? ' (A)' : ' (V)'}${size}`;
      formatSelect.appendChild(opt);
    });

    setStatus(`Found ${filtered.length} formats (showing filtered)`);

    // If autoSelect checked, pick the best candidate (first in filtered)
    if (autoSelect && autoSelect.checked && filtered.length) {
      formatSelect.value = String(filtered[0].itag);
      setStatus(`Auto-selected itag ${filtered[0].itag} (${filtered[0].qualityLabel || 'audio'})`);
    }
  } catch (err) {
    console.error(err);
    setStatus('Failed to fetch formats', true);
  } finally {
    fetchFormatsBtn.disabled = false;
  }
}

fetchFormatsBtn && fetchFormatsBtn.addEventListener('click', fetchFormats);
