import 'dotenv/config';
import express from 'express';
import Redis from 'ioredis';
import dayjs from 'dayjs';
import rateLimit from 'express-rate-limit';

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

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const k = req.header('x-api-key');
  if (k !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}
app.use(requireApiKey);

const POOL_START = parseInt(PORT_POOL_START, 10);
const POOL_END   = parseInt(PORT_POOL_END, 10);
const RESERVE_TTL = parseInt(RESERVE_TTL_SEC, 10);
const REG_DEFAULT = parseInt(REGISTER_TTL_DEFAULT_SEC, 10);
const REG_MAX     = parseInt(REGISTER_TTL_MAX_SEC, 10);

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
    if (!deviceId || typeof deviceId !== 'string') {
      return res.status(400).json({ error: 'deviceId required' });
    }
    const oldPort = await redis.get(`alloc:${deviceId}`);
    if (oldPort) {
      await redis.expire(`alloc:${deviceId}`, RESERVE_TTL);
      await redis.expire(`port:${oldPort}`, RESERVE_TTL);
      return res.json({ remotePort: Number(oldPort), ttlSec: RESERVE_TTL });
    }

    const port = await findFreePort();
    if (!port) return res.status(503).json({ error: 'no free port' });

    const ok = await redis.setnx(`port:${port}`, `reserved_by:${deviceId}`);
    if (!ok) return res.status(503).json({ error: 'race: port taken, retry' });
    await redis.expire(`port:${port}`, RESERVE_TTL);
    await redis.set(`alloc:${deviceId}`, String(port), 'EX', RESERVE_TTL);

    res.json({ remotePort: port, ttlSec: RESERVE_TTL });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { deviceId, remotePort, fileName, ttlSec } = req.body || {};
    if (!deviceId || !remotePort || !fileName) {
      return res.status(400).json({ error: 'deviceId, remotePort, fileName required' });
    }
    const ttl = Math.min(Math.max(parseInt(ttlSec ?? REG_DEFAULT, 10), 1), REG_MAX);

    const reservedVal = await redis.get(`port:${remotePort}`);
    if (!reservedVal) {
      return res.status(410).json({ error: 'alloc expired or port not reserved' });
    }
    if (reservedVal !== `reserved_by:${deviceId}`) {
      return res.status(409).json({ error: 'port not reserved by this deviceId' });
    }

    await redis.del(`port:${remotePort}`);
    await redis.del(`alloc:${deviceId}`);

    const devKey = `dev:${deviceId}`;
    const payload = { remotePort: Number(remotePort), fileName };
    await redis.set(devKey, JSON.stringify(payload), 'EX', ttl);
    await redis.set(`port:inuse:${remotePort}`, deviceId, 'EX', ttl);

    const expiresAt = dayjs().add(ttl, 'second').toISOString();
    res.json({ deviceId, remotePort: Number(remotePort), fileName, expiresAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/free', async (req, res) => {
  try {
    const { deviceId, remotePort } = req.body || {};
    if (!deviceId || !remotePort) {
      return res.status(400).json({ error: 'deviceId, remotePort required' });
    }
    await redis.del(`port:${remotePort}`);
    await redis.del(`alloc:${deviceId}`);
    await redis.del(`dev:${deviceId}`);
    await redis.del(`port:inuse:${remotePort}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/proxy', async (req, res) => {
  try {
    const port = parseInt(String(req.query.port || ''), 10);
    const path = String(req.query.path || '/download');

    if (!Number.isFinite(port) || port < 1024 || port > 65535) {
      return res.status(400).json({ error: 'invalid port' });
    }

    // (Tối giản theo yêu cầu của bạn: chỉ cần port; nếu muốn bảo mật hơn,
    // bạn có thể kiểm tra port có đang in-use trong Redis: port:inuse:<port>)

    const opts = {
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        // forward các header cơ bản nếu cần
      }
    };

    const proxyReq = http.request(opts, (upstream) => {
      // copy status + headers xuống client
      res.status(upstream.statusCode || 200);
      Object.entries(upstream.headers).forEach(([k, v]) => {
        if (v) res.setHeader(k, v);
      });
      upstream.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('proxy error:', err.message);
      res.status(502).json({ error: 'bad gateway' });
    });

    proxyReq.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal' });
  }
});

// Nếu API chỉ nội bộ VPS, có thể đổi 0.0.0.0 -> '127.0.0.1'
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Control API listening on :${PORT}`);
});


