const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('[RPC] DISCORD_TOKEN is not set!');
  process.exit(1);
}

// ── Image server ──────────────────────────────────────────────
// Railway (and Replit) both need an HTTP server. We use it to serve
// our image so Discord can always reach it via a stable public URL.
const PORT = process.env.PORT || 3000;
const IMAGE_PATH = path.join(__dirname, 'public', 'rpc-image.png');

const httpServer = http.createServer((req, res) => {
  if (req.url === '/rpc-image.png') {
    fs.readFile(IMAGE_PATH, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(data);
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Discord RPC Bot is running');
  }
});

httpServer.listen(PORT, () => {
  console.log(`[HTTP] Image server listening on port ${PORT}`);
});

// ── Public image URL ──────────────────────────────────────────
// Supports GitHub Actions (IMAGE_URL), Railway, and Replit.
function getImageUrl() {
  // GitHub Actions sets IMAGE_URL to the raw GitHub content URL
  if (process.env.IMAGE_URL) {
    return process.env.IMAGE_URL;
  }

  // Railway or Replit hosted domain
  const domain =
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    process.env.REPLIT_DOMAINS ||
    process.env.REPLIT_DEV_DOMAIN;

  if (domain) {
    return `https://${domain}/rpc-image.png`;
  }

  // Local fallback — bot still runs, just without image
  return null;
}

// ── Config ────────────────────────────────────────────────────
const START_TIMESTAMP = Date.now() - (368 * 3600 + 38 * 60 + 17) * 1000;
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DISCORD_API = 'https://discord.com/api/v9';

// ── Opcodes ───────────────────────────────────────────────────
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  STATUS_UPDATE: 3,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

// ── State ─────────────────────────────────────────────────────
let ws = null;
let heartbeatInterval = null;
let sequence = null;
let reconnectDelay = 5000;
let refreshInterval = null;
let proxiedImageUrl = null;

// ── Get Discord-proxied image URL ─────────────────────────────
async function fetchProxiedImageUrl(appId, rawUrl) {
  try {
    console.log(`[RPC] Registering image: ${rawUrl}`);
    const res = await fetch(`${DISCORD_API}/applications/${appId}/external-assets`, {
      method: 'POST',
      headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [rawUrl] }),
    });

    if (!res.ok) {
      console.warn(`[RPC] Discord proxy API ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    if (data && data[0] && data[0].external_asset_path) {
      const url = `mp:${data[0].external_asset_path}`;
      console.log(`[RPC] Proxied image URL: ${url}`);
      return url;
    }
    return null;
  } catch (err) {
    console.error('[RPC] Error registering image:', err.message);
    return null;
  }
}

// ── Presence ──────────────────────────────────────────────────
function buildPresence() {
  const activity = {
    name: 'her absence',
    type: 3, // WATCHING
    details: 'She is just a memory',
    state: 'She will be in my memory Forever',
    timestamps: { start: START_TIMESTAMP },
  };

  if (proxiedImageUrl) {
    activity.assets = {
      large_image: proxiedImageUrl,
      large_text: 'She is just a memory',
    };
  }

  return {
    op: OP.STATUS_UPDATE,
    d: { since: null, status: 'dnd', afk: false, activities: [activity] },
  };
}

function buildIdentify() {
  return {
    op: OP.IDENTIFY,
    d: {
      token: TOKEN,
      properties: { os: 'Windows', browser: 'Discord Client', device: 'desktop' },
      presence: buildPresence().d,
      intents: 0,
    },
  };
}

// ── Heartbeat ─────────────────────────────────────────────────
function startHeartbeat(interval) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: sequence }));
    }
  }, interval);
}

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// ── Connect ───────────────────────────────────────────────────
async function connect() {
  // Get app ID
  let appId = '463151177836658699';
  try {
    const res = await fetch(`${DISCORD_API}/applications/@me`, {
      headers: { Authorization: TOKEN },
    });
    if (res.ok) {
      const data = await res.json();
      appId = data.id;
      console.log(`[RPC] App ID: ${appId}`);
    }
  } catch {}

  // Register image with Discord proxy
  const imageUrl = getImageUrl();
  console.log(`[RPC] Image URL: ${imageUrl}`);
  proxiedImageUrl = await fetchProxiedImageUrl(appId, imageUrl);

  // Open gateway
  console.log('[RPC] Connecting to Discord gateway...');
  ws = new WebSocket(GATEWAY_URL);

  ws.on('open', () => {
    console.log('[RPC] Connected to Discord');
    reconnectDelay = 5000;
  });

  ws.on('message', (data) => {
    let payload;
    try { payload = JSON.parse(data); } catch { return; }

    const { op, d, t, s } = payload;
    if (s) sequence = s;

    switch (op) {
      case OP.HELLO:
        console.log(`[RPC] Heartbeat: every ${d.heartbeat_interval}ms`);
        startHeartbeat(d.heartbeat_interval);
        ws.send(JSON.stringify(buildIdentify()));
        break;

      case OP.DISPATCH:
        if (t === 'READY') {
          const user = d.user;
          console.log(`[RPC] ✓ Logged in as ${user.username}`);
          console.log(`[RPC] ✓ Status: DND`);
          console.log(`[RPC] ✓ Activity: Watching her absence`);
          console.log(`[RPC] ✓ Image: ${proxiedImageUrl ? 'set' : 'not available'}`);
          console.log(`[RPC] ✓ Timer: running since ${new Date(START_TIMESTAMP).toUTCString()}`);

          ws.send(JSON.stringify(buildPresence()));

          if (refreshInterval) clearInterval(refreshInterval);
          refreshInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(buildPresence()));
              console.log('[RPC] Presence refreshed');
            }
          }, 5 * 60 * 1000);
        }
        break;

      case OP.HEARTBEAT:
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: sequence }));
        }
        break;

      default:
        break;
    }
  });

  ws.on('close', (code) => {
    console.warn(`[RPC] Disconnected (${code}) — reconnecting in ${reconnectDelay / 1000}s`);
    stopHeartbeat();
    if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });

  ws.on('error', (err) => console.error('[RPC] Error:', err.message));
}

process.on('uncaughtException', (err) => console.error('[RPC] Uncaught:', err.message));
process.on('unhandledRejection', (r) => console.error('[RPC] Rejection:', r));

connect();
