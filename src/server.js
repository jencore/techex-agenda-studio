const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { parseAgendaHtml, autofillMeta } = require('./parser');

// node-fetch v3 is ESM-only, use dynamic import
let fetchFn;
async function getFetch() {
  if (!fetchFn) {
    const mod = await import('node-fetch');
    fetchFn = mod.default;
  }
  return fetchFn;
}

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security & middleware ──────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // frontend sets its own
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Health check ───────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// ── Main API: fetch + parse agenda ────────────────────
app.post('/api/fetch-agenda', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid url' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only http/https URLs allowed' });
  }

  const fetch = await getFetch();

  // Multiple User-Agent strings to try
  const userAgents = [
    // Googlebot - many sites whitelist crawlers
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    // Regular Chrome on Mac
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    // Chrome on Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    // Firefox
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  ];

  let html;
  let lastError;

  for (const ua of userAgents) {
    try {
      const isGooglebot = ua.includes('Googlebot');
      const headers = isGooglebot
        ? {
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          }
        : {
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-GB,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Ch-Ua': ua.includes('Chrome') ? '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"' : undefined,
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': ua.includes('Macintosh') ? '"macOS"' : '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
          };

      // Remove undefined values
      Object.keys(headers).forEach(k => headers[k] === undefined && delete headers[k]);

      const response = await fetch(url, {
        headers,
        redirect: 'follow',
        timeout: 15000,
      });

      if (response.ok) {
        html = await response.text();
        if (html && html.length >= 200) break; // success
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  if (!html || html.length < 200) {
    return res.status(502).json({
      error: `Could not fetch the page (${lastError || 'no content'}). The site may block automated access — try the "Paste HTML" option instead.`
    });
  }

  if (!html || html.length < 200) {
    return res.status(502).json({ error: 'The page returned no content.' });
  }

  const { sessions, strategy } = parseAgendaHtml(html);
  const meta = autofillMeta(html, url);

  if (!sessions.length) {
    return res.status(422).json({
      error: 'No sessions found on this page. The site may use a structure we don\'t support yet — try the "Paste HTML" option.',
      meta,
    });
  }

  res.json({ sessions, meta, strategy, sessionCount: sessions.length });
});

// ── Parse pasted HTML ─────────────────────────────────
app.post('/api/parse-html', (req, res) => {
  const { html, url } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Missing html' });
  }
  const { sessions, strategy } = parseAgendaHtml(html);
  const meta = autofillMeta(html, url || '');
  if (!sessions.length) {
    return res.status(422).json({ error: 'No sessions found in the pasted HTML.' });
  }
  res.json({ sessions, meta, strategy, sessionCount: sessions.length });
});

// ── Show server outbound IP (for whitelisting) ────────
app.get('/api/my-ip', async (req, res) => {
  try {
    const fetch = await getFetch();
    const r = await fetch('https://api.ipify.org?format=json');
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fallback: serve index.html for any non-API route ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`TechEx Agenda Studio running on http://localhost:${PORT}`);
});
