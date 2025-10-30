import 'dotenv/config';
import express from 'express';
import Redis from 'ioredis';
import dayjs from 'dayjs';
import rateLimit from 'express-rate-limit';
import * as http from 'node:http';

const app = express();
app.use(express.json({ limit: '256kb' }));

const limiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use(limiter);

const {
  PORT = 9000,
  REDIS_URL = 'redis://127.0.0.1:6379',
  PORT_POOL_START = '29000',
  PORT_POOL_END = '39999',
  RESERVE_TTL_SEC = '60',
  REGISTER_TTL_DEFAULT_SEC = '900',
  REGISTER_TTL_MAX_SEC = '86400',
  API_KEY,
} = process.env;

const redis = new Redis(REDIS_URL);

// Log Redis connection
redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));
redis.on('close', () => console.warn('[Redis] Connection closed'));

function requireApiKey(req, res, next) {
  if (req.path === '/proxy') return next();
  const k = req.header('x-api-key');
  if (process.env.API_KEY && k !== process.env.API_KEY) {
    console.warn(`[Auth] Unauthorized access attempt to ${req.path} from ${req.ip}`);
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
app.use(requireApiKey);

const POOL_START = parseInt(PORT_POOL_START, 10);
const POOL_END   = parseInt(PORT_POOL_END, 10);
const RESERVE_TTL = parseInt(RESERVE_TTL_SEC, 10);
const REG_DEFAULT = parseInt(REGISTER_TTL_DEFAULT_SEC, 10);
const REG_MAX     = parseInt(REGISTER_TTL_MAX_SEC, 10);

console.log('[Config] Port pool:', POOL_START, '-', POOL_END);
console.log('[Config] Reserve TTL:', RESERVE_TTL, 'sec');
console.log('[Config] Register TTL:', REG_DEFAULT, '-', REG_MAX, 'sec');
console.log('[Config] API Key:', API_KEY ? '✓ enabled' : '✗ disabled');

async function findFreePort() {
  for (let p = POOL_START; p <= POOL_END; p++) {
    const inUse = await redis.exists(`port:inuse:${p}`);
    if (inUse) continue;
    const reserved = await redis.exists(`port:${p}`);
    if (reserved) continue;
    return p;
  }
  return null;
}

app.post('/alloc', async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    console.log(`[/alloc] Request from deviceId: ${deviceId}`);
    
    if (!deviceId || typeof deviceId !== 'string') {
      console.warn('[/alloc] Missing or invalid deviceId');
      return res.status(400).json({ error: 'deviceId required' });
    }
    
    const oldPort = await redis.get(`alloc:${deviceId}`);
    if (oldPort) {
      console.log(`[/alloc] Reusing existing port ${oldPort} for deviceId: ${deviceId}`);
      await redis.expire(`alloc:${deviceId}`, RESERVE_TTL);
      await redis.expire(`port:${oldPort}`, RESERVE_TTL);
      return res.json({ remotePort: Number(oldPort), ttlSec: RESERVE_TTL });
    }

    const port = await findFreePort();
    if (!port) {
      console.error('[/alloc] No free port available in pool');
      return res.status(503).json({ error: 'no free port' });
    }

    const ok = await redis.setnx(`port:${port}`, `reserved_by:${deviceId}`);
    if (!ok) {
      console.warn(`[/alloc] Race condition: port ${port} taken by another request`);
      return res.status(503).json({ error: 'race: port taken, retry' });
    }
    
    await redis.expire(`port:${port}`, RESERVE_TTL);
    await redis.set(`alloc:${deviceId}`, String(port), 'EX', RESERVE_TTL);

    console.log(`[/alloc] ✓ Allocated port ${port} to deviceId: ${deviceId}, TTL: ${RESERVE_TTL}s`);
    res.json({ remotePort: port, ttlSec: RESERVE_TTL });
  } catch (e) {
    console.error('[/alloc] Error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { deviceId, remotePort, fileName, ttlSec } = req.body || {};
    console.log(`[/register] Request - deviceId: ${deviceId}, port: ${remotePort}, file: ${fileName}, ttl: ${ttlSec}`);
    
    if (!deviceId || !remotePort || !fileName) {
      console.warn('[/register] Missing required fields');
      return res.status(400).json({ error: 'deviceId, remotePort, fileName required' });
    }
    
    const ttl = Math.min(Math.max(parseInt(ttlSec ?? REG_DEFAULT, 10), 1), REG_MAX);
    if (ttl !== ttlSec) {
      console.log(`[/register] TTL adjusted from ${ttlSec} to ${ttl}`);
    }

    const reservedVal = await redis.get(`port:${remotePort}`);
    if (!reservedVal) {
      console.error(`[/register] Port ${remotePort} not reserved or expired`);
      return res.status(410).json({ error: 'alloc expired or port not reserved' });
    }
    
    if (reservedVal !== `reserved_by:${deviceId}`) {
      console.error(`[/register] Port ${remotePort} reserved by ${reservedVal}, not ${deviceId}`);
      return res.status(409).json({ error: 'port not reserved by this deviceId' });
    }

    await redis.del(`port:${remotePort}`);
    await redis.del(`alloc:${deviceId}`);

    const devKey = `dev:${deviceId}`;
    const payload = { remotePort: Number(remotePort), fileName };
    await redis.set(devKey, JSON.stringify(payload), 'EX', ttl);
    await redis.set(`port:inuse:${remotePort}`, deviceId, 'EX', ttl);

    const expiresAt = dayjs().add(ttl, 'second').toISOString();
    console.log(`[/register] ✓ Registered deviceId: ${deviceId}, port: ${remotePort}, file: ${fileName}, expires: ${expiresAt}`);
    
    res.json({ deviceId, remotePort: Number(remotePort), fileName, expiresAt });
  } catch (e) {
    console.error('[/register] Error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/free', async (req, res) => {
  try {
    const { deviceId, remotePort } = req.body || {};
    console.log(`[/free] Request - deviceId: ${deviceId}, port: ${remotePort}`);
    
    if (!deviceId || !remotePort) {
      console.warn('[/free] Missing required fields');
      return res.status(400).json({ error: 'deviceId, remotePort required' });
    }
    
    await redis.del(`port:${remotePort}`);
    await redis.del(`alloc:${deviceId}`);
    await redis.del(`dev:${deviceId}`);
    await redis.del(`port:inuse:${remotePort}`);
    
    console.log(`[/free] ✓ Freed port ${remotePort} for deviceId: ${deviceId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[/free] Error:', e);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/proxy', async (req, res) => {
  try {
    const port = Number(req.query.port);
    const path = typeof req.query.path === 'string' ? req.query.path : '/download';

    console.log(`[/proxy] Request - port: ${port}, path: ${path}, from: ${req.ip}`);

    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      console.warn(`[/proxy] Invalid port: ${port}`);
      return res.status(400).json({ error: 'invalid port' });
    }

    const opts = { host: '127.0.0.1', port, path, method: 'GET', timeout: 15000 };
    const hopByHop = new Set([
      'connection','keep-alive','proxy-authenticate','proxy-authorization',
      'te','trailer','transfer-encoding','upgrade'
    ]);

    const startTime = Date.now();
    const upstreamReq = http.request(opts, (upstream) => {
      const duration = Date.now() - startTime;
      console.log(`[/proxy] ✓ Upstream responded - status: ${upstream.statusCode}, duration: ${duration}ms`);
      
      res.statusCode = upstream.statusCode || 200;
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (v && !hopByHop.has(k.toLowerCase()) && !res.headersSent) res.setHeader(k, v);
      }
      upstream.pipe(res);
      
      upstream.on('end', () => {
        const totalDuration = Date.now() - startTime;
        console.log(`[/proxy] ✓ Transfer complete - total duration: ${totalDuration}ms`);
      });
    });

    upstreamReq.on('timeout', () => {
      console.error(`[/proxy] Timeout after 15s for port ${port}`);
      upstreamReq.destroy(new Error('upstream timeout'));
    });
    
    upstreamReq.on('error', (err) => {
      console.error(`[/proxy] Upstream error for port ${port}:`, err.message);
      if (!res.headersSent) res.status(502).json({ error: 'bad gateway', detail: err.message });
      else try { res.end(); } catch (_e) {}
    });

    upstreamReq.end();
  } catch (e) {
    console.error('[/proxy] Handler error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'internal', detail: String(e.message || e) });
  }
});

// Middleware để log tất cả requests
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// Nếu API chỉ nội bộ VPS, có thể đổi 0.0.0.0 -> '127.0.0.1'
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Control API listening on :${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
});