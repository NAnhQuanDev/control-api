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

// ═══════════════════════════════════════════════════════════
// PRETTY LOGGING UTILITIES
// ═══════════════════════════════════════════════════════════
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
};

const timestamp = () => colors.gray + dayjs().format('YYYY-MM-DD HH:mm:ss') + colors.reset;

const log = {
  info: (tag, msg, data = {}) => {
    console.log(`${timestamp()} ${colors.blue}ℹ ${tag}${colors.reset} ${msg}`);
    if (Object.keys(data).length > 0) {
      console.log(colors.dim + '  └─ ' + JSON.stringify(data, null, 2).split('\n').join('\n     ') + colors.reset);
    }
  },
  
  success: (tag, msg, data = {}) => {
    console.log(`${timestamp()} ${colors.green}✓ ${tag}${colors.reset} ${msg}`);
    if (Object.keys(data).length > 0) {
      console.log(colors.dim + '  └─ ' + JSON.stringify(data, null, 2).split('\n').join('\n     ') + colors.reset);
    }
  },
  
  warn: (tag, msg, data = {}) => {
    console.log(`${timestamp()} ${colors.yellow}⚠ ${tag}${colors.reset} ${msg}`);
    if (Object.keys(data).length > 0) {
      console.log(colors.dim + '  └─ ' + JSON.stringify(data, null, 2).split('\n').join('\n     ') + colors.reset);
    }
  },
  
  error: (tag, msg, error = null) => {
    console.log(`${timestamp()} ${colors.red}✗ ${tag}${colors.reset} ${msg}`);
    if (error) {
      console.log(colors.red + '  └─ ' + (error.stack || error.message || error) + colors.reset);
    }
  },
  
  request: (method, path, status, duration) => {
    const statusColor = status >= 500 ? colors.red : status >= 400 ? colors.yellow : colors.green;
    const methodColor = method === 'GET' ? colors.cyan : method === 'POST' ? colors.magenta : colors.blue;
    console.log(
      `${timestamp()} ${methodColor}${method.padEnd(6)}${colors.reset} ${path.padEnd(20)} ${statusColor}${status}${colors.reset} ${colors.gray}${duration}ms${colors.reset}`
    );
  },
  
  box: (title, lines) => {
    const width = Math.max(title.length, ...lines.map(l => l.length)) + 4;
    console.log(colors.cyan + '╔' + '═'.repeat(width) + '╗' + colors.reset);
    console.log(colors.cyan + '║ ' + colors.bright + title.padEnd(width - 1) + colors.reset + colors.cyan + '║' + colors.reset);
    console.log(colors.cyan + '╠' + '═'.repeat(width) + '╣' + colors.reset);
    lines.forEach(line => {
      console.log(colors.cyan + '║ ' + colors.reset + line.padEnd(width - 1) + colors.cyan + '║' + colors.reset);
    });
    console.log(colors.cyan + '╚' + '═'.repeat(width) + '╝' + colors.reset);
  }
};

// ═══════════════════════════════════════════════════════════
// REDIS CONNECTION
// ═══════════════════════════════════════════════════════════
const redis = new Redis(REDIS_URL);

redis.on('connect', () => log.success('REDIS', 'Connected successfully'));
redis.on('error', (err) => log.error('REDIS', 'Connection error', err));
redis.on('close', () => log.warn('REDIS', 'Connection closed'));

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════
function requireApiKey(req, res, next) {
  if (req.path === '/proxy') return next();
  const k = req.header('x-api-key');
  if (process.env.API_KEY && k !== process.env.API_KEY) {
    log.warn('AUTH', `Unauthorized access attempt to ${req.path}`, { ip: req.ip });
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
app.use(requireApiKey);

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    log.request(req.method, req.path, res.statusCode, duration);
  });
  next();
});

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════
const POOL_START = parseInt(PORT_POOL_START, 10);
const POOL_END   = parseInt(PORT_POOL_END, 10);
const RESERVE_TTL = parseInt(RESERVE_TTL_SEC, 10);
const REG_DEFAULT = parseInt(REGISTER_TTL_DEFAULT_SEC, 10);
const REG_MAX     = parseInt(REGISTER_TTL_MAX_SEC, 10);

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════
app.post('/alloc', async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    
    if (!deviceId || typeof deviceId !== 'string') {
      log.warn('ALLOC', 'Missing or invalid deviceId');
      return res.status(400).json({ error: 'deviceId required' });
    }
    
    log.info('ALLOC', `Request from ${colors.cyan}${deviceId}${colors.reset}`);
    
    const oldPort = await redis.get(`alloc:${deviceId}`);
    if (oldPort) {
      await redis.expire(`alloc:${deviceId}`, RESERVE_TTL);
      await redis.expire(`port:${oldPort}`, RESERVE_TTL);
      log.success('ALLOC', `Reused existing port`, { 
        deviceId, 
        port: Number(oldPort), 
        ttl: RESERVE_TTL 
      });
      return res.json({ remotePort: Number(oldPort), ttlSec: RESERVE_TTL });
    }

    const port = await findFreePort();
    if (!port) {
      log.error('ALLOC', 'No free port available in pool');
      return res.status(503).json({ error: 'no free port' });
    }

    const ok = await redis.setnx(`port:${port}`, `reserved_by:${deviceId}`);
    if (!ok) {
      log.warn('ALLOC', `Race condition: port ${port} taken`);
      return res.status(503).json({ error: 'race: port taken, retry' });
    }
    
    await redis.expire(`port:${port}`, RESERVE_TTL);
    await redis.set(`alloc:${deviceId}`, String(port), 'EX', RESERVE_TTL);

    log.success('ALLOC', `Allocated new port`, { 
      deviceId, 
      port, 
      ttl: RESERVE_TTL 
    });
    
    res.json({ remotePort: port, ttlSec: RESERVE_TTL });
  } catch (e) {
    log.error('ALLOC', 'Internal error', e);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { deviceId, remotePort, fileName, ttlSec } = req.body || {};
    
    if (!deviceId || !remotePort || !fileName) {
      log.warn('REGISTER', 'Missing required fields');
      return res.status(400).json({ error: 'deviceId, remotePort, fileName required' });
    }
    
    log.info('REGISTER', `Request`, { deviceId, remotePort, fileName });
    
    const ttl = Math.min(Math.max(parseInt(ttlSec ?? REG_DEFAULT, 10), 1), REG_MAX);
    if (ttl !== ttlSec) {
      log.info('REGISTER', `TTL adjusted: ${ttlSec} → ${ttl}`);
    }

    const reservedVal = await redis.get(`port:${remotePort}`);
    if (!reservedVal) {
      log.error('REGISTER', `Port ${remotePort} not reserved or expired`);
      return res.status(410).json({ error: 'alloc expired or port not reserved' });
    }
    
    if (reservedVal !== `reserved_by:${deviceId}`) {
      log.error('REGISTER', `Port mismatch`, { 
        port: remotePort, 
        expected: deviceId, 
        actual: reservedVal 
      });
      return res.status(409).json({ error: 'port not reserved by this deviceId' });
    }

    await redis.del(`port:${remotePort}`);
    await redis.del(`alloc:${deviceId}`);

    const devKey = `dev:${deviceId}`;
    const payload = { remotePort: Number(remotePort), fileName };
    await redis.set(devKey, JSON.stringify(payload), 'EX', ttl);
    await redis.set(`port:inuse:${remotePort}`, deviceId, 'EX', ttl);

    const expiresAt = dayjs().add(ttl, 'second').toISOString();
    log.success('REGISTER', `Service registered`, { 
      deviceId, 
      port: remotePort, 
      fileName, 
      ttl,
      expiresAt 
    });
    
    res.json({ deviceId, remotePort: Number(remotePort), fileName, expiresAt });
  } catch (e) {
    log.error('REGISTER', 'Internal error', e);
    res.status(500).json({ error: 'internal' });
  }
});

app.post('/free', async (req, res) => {
  try {
    const { deviceId, remotePort } = req.body || {};
    
    if (!deviceId || !remotePort) {
      log.warn('FREE', 'Missing required fields');
      return res.status(400).json({ error: 'deviceId, remotePort required' });
    }
    
    await redis.del(`port:${remotePort}`);
    await redis.del(`alloc:${deviceId}`);
    await redis.del(`dev:${deviceId}`);
    await redis.del(`port:inuse:${remotePort}`);
    
    log.success('FREE', `Port released`, { deviceId, port: remotePort });
    res.json({ ok: true });
  } catch (e) {
    log.error('FREE', 'Internal error', e);
    res.status(500).json({ error: 'internal' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/proxy', async (req, res) => {
  try {
    const port = Number(req.query.port);
    const path = typeof req.query.path === 'string' ? req.query.path : '/download';

    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      log.warn('PROXY', `Invalid port: ${port}`);
      return res.status(400).json({ error: 'invalid port' });
    }

    log.info('PROXY', `Forwarding request`, { port, path, ip: req.ip });

    const opts = { host: '127.0.0.1', port, path, method: 'GET', timeout: 15000 };
    const hopByHop = new Set([
      'connection','keep-alive','proxy-authenticate','proxy-authorization',
      'te','trailer','transfer-encoding','upgrade'
    ]);

    const startTime = Date.now();
    const upstreamReq = http.request(opts, (upstream) => {
      const duration = Date.now() - startTime;
      log.success('PROXY', `Upstream responded`, { 
        port, 
        status: upstream.statusCode, 
        duration: `${duration}ms` 
      });
      
      res.statusCode = upstream.statusCode || 200;
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (v && !hopByHop.has(k.toLowerCase()) && !res.headersSent) res.setHeader(k, v);
      }
      upstream.pipe(res);
      
      upstream.on('end', () => {
        const totalDuration = Date.now() - startTime;
        log.success('PROXY', `Transfer completed`, { 
          port, 
          totalDuration: `${totalDuration}ms` 
        });
      });
    });

    upstreamReq.on('timeout', () => {
      log.error('PROXY', `Timeout after 15s`, { port });
      upstreamReq.destroy(new Error('upstream timeout'));
    });
    
    upstreamReq.on('error', (err) => {
      log.error('PROXY', `Upstream error`, err);
      if (!res.headersSent) res.status(502).json({ error: 'bad gateway', detail: err.message });
      else try { res.end(); } catch (_e) {}
    });

    upstreamReq.end();
  } catch (e) {
    log.error('PROXY', 'Handler error', e);
    if (!res.headersSent) res.status(500).json({ error: 'internal', detail: String(e.message || e) });
  }
});

// ═══════════════════════════════════════════════════════════
// SERVER START
// ═══════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  log.box('Control API Server', [
    `Port: ${PORT}`,
    `Environment: ${process.env.NODE_ENV || 'development'}`,
    `Port Pool: ${POOL_START} - ${POOL_END}`,
    `Reserve TTL: ${RESERVE_TTL}s`,
    `Register TTL: ${REG_DEFAULT}s - ${REG_MAX}s`,
    `API Key: ${API_KEY ? '✓ enabled' : '✗ disabled'}`,
    `Redis: ${REDIS_URL}`
  ]);
});