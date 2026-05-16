import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mountRoutes } from './routes.js';
import logger from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Simple session tokens for web auth
const validTokens = new Set();

function authMiddleware(req, res, next) {
  const password = process.env.WEB_AUTH_PASSWORD;
  if (!password) return next(); // no auth configured

  // Allow the login endpoint through
  if (req.path === '/api/login') return next();

  // Check bearer token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (validTokens.has(token)) return next();
  }

  // Check cookie
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies.autonome_token && validTokens.has(cookies.autonome_token)) return next();

  // For API requests, return 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  // For page requests, serve login page
  return res.send(LOGIN_PAGE);
}

function parseCookies(cookieStr) {
  const cookies = {};
  cookieStr.split(';').forEach(c => {
    const [key, ...rest] = c.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SUBARU — Login</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0a0a0a; color: #e0e0e0; font-family: 'Geist Mono', monospace; display: flex; justify-content: center; align-items: center; height: 100vh; }
.login-box { border: 1px solid rgba(0,212,255,0.2); padding: 40px; max-width: 360px; width: 100%; }
h1 { color: #00d4ff; font-size: 18px; letter-spacing: 6px; margin-bottom: 24px; text-align: center; }
input { width: 100%; background: #0d0d0d; border: 1px solid rgba(0,212,255,0.15); color: #e0e0e0; font-family: inherit; font-size: 13px; padding: 10px 14px; margin-bottom: 16px; outline: none; }
input:focus { border-color: rgba(0,212,255,0.35); }
button { width: 100%; background: #00d4ff; color: #0a0a0a; font-family: inherit; font-size: 12px; font-weight: 700; padding: 10px; border: none; cursor: pointer; letter-spacing: 1px; text-transform: uppercase; }
button:hover { opacity: 0.85; }
.error { color: #ff4444; font-size: 11px; margin-bottom: 12px; display: none; }
</style></head><body>
<div class="login-box"><h1>SUBARU</h1>
<div class="error" id="err">Invalid password</div>
<form onsubmit="return doLogin(event)">
<input type="password" id="pw" placeholder="Password" autofocus>
<button type="submit">LOGIN</button>
</form></div>
<script>
async function doLogin(e) {
  e.preventDefault();
  const pw = document.getElementById('pw').value;
  try {
    const r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:pw}) });
    if (r.ok) { const d = await r.json(); document.cookie='autonome_token='+d.token+';path=/;SameSite=Strict'; location.reload(); }
    else { document.getElementById('err').style.display='block'; }
  } catch { document.getElementById('err').style.display='block'; }
  return false;
}
</script></body></html>`;

// Simple in-memory rate limiter
function createRateLimiter(windowMs = 60000, maxRequests = 30) {
  const hits = new Map();

  // Cleanup every minute
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of hits) {
      if (now - data.start > windowMs) hits.delete(ip);
    }
  }, windowMs);

  return (req, res, next) => {
    // Only rate-limit POST /api/chat
    if (req.method !== 'POST' || req.path !== '/api/chat') return next();

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let data = hits.get(ip);

    if (!data || now - data.start > windowMs) {
      data = { start: now, count: 0 };
      hits.set(ip, data);
    }

    data.count++;
    if (data.count > maxRequests) {
      logger.warn(`Rate limit exceeded for ${ip}`);
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }

    next();
  };
}

/**
 * Start the Express web server.
 */
export function start(port = 3131) {
  const app = express();

  app.use(express.json({ limit: '20mb' }));

  // Rate limiting
  app.use(createRateLimiter(60000, 30));

  // Auth middleware
  app.use(authMiddleware);

  // Login endpoint
  app.post('/api/login', (req, res) => {
    const password = process.env.WEB_AUTH_PASSWORD;
    if (!password) return res.json({ token: 'no-auth' });
    if (req.body?.password === password) {
      const token = crypto.randomBytes(32).toString('hex');
      validTokens.add(token);
      logger.info('Web dashboard: user authenticated.');
      return res.json({ token });
    }
    return res.status(403).json({ error: 'Invalid password.' });
  });

  // Logout endpoint
  app.post('/api/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    if (cookies.autonome_token) validTokens.delete(cookies.autonome_token);
    res.json({ success: true });
  });

  // Serve static files
  app.use(express.static(path.join(__dirname, 'public')));

  // Mount API routes
  mountRoutes(app);

  // Documentation page
  app.get('/docs', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'docs.html'));
  });

  // Fallback to index.html
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Error handler
  app.use((err, req, res, next) => {
    logger.error(`Web server error: ${err.message}`);
    res.status(500).json({ error: err.message });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info(`Web dashboard running at http://localhost:${port}`);
      resolve(server);
    });

    server.on('error', (err) => {
      logger.error(`Web server failed to start: ${err.message}`);
      reject(err);
    });
  });
}

export function stop(server) {
  if (server) {
    server.close();
  }
}

export default { start, stop };
