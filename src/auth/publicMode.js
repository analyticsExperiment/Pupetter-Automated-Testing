const { timingSafeEqual } = require('node:crypto');

function readPublicSettings(env = process.env) {
  const enabled = env.FREE_AUDIT_PUBLIC_MODE === '1';
  const username = String(env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const password = String(env.ADMIN_PASSWORD || '');
  const secret = String(env.SESSION_SECRET || '');
  if (enabled && (!/^[a-z0-9_.-]{3,32}$/.test(username)
    || password.length < 20 || password === 'audit123'
    || secret.length < 32 || secret === 'audit-secret')) {
    throw new Error('Public mode requires an ADMIN_USERNAME, ADMIN_PASSWORD of at least 20 characters, and SESSION_SECRET of at least 32 characters.');
  }
  return { enabled, username, password, secret };
}

function equalToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicRequestGuard(settings, resolveExtensionToken) {
  const buckets = new Map();
  const windowMs = 10 * 60 * 1000;
  return (req, res, next) => {
    if (!settings.enabled) return next();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    // Only cloudflared/loopback is trusted to report HTTPS; direct HTTP stays local.
    if (!req.secure) return res.status(400).json({ error: 'Public mode requires HTTPS through the tunnel.' });
    if (req.path === '/auth/login' || req.path === '/api/auth/csrf') {
      const now = Date.now();
      for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key);
      const key = req.ip;
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= 1000) return res.status(429).json({ error: 'Too many login requests. Try later.' });
        bucket = { count: 0, until: now + windowMs };
        buckets.set(key, bucket);
      }
      if (++bucket.count > 40) {
        res.setHeader('Retry-After', Math.ceil((bucket.until - now) / 1000));
        return res.status(429).json({ error: 'Too many login requests. Try later.' });
      }
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Privileged extension calls use a revocable bearer token instead of cookies.
    if (req.path.startsWith('/api/extension/')) {
      const token = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1];
      const resolved = token && resolveExtensionToken(token);
      if (resolved?.username === settings.username) return next();
    }
    const origin = req.headers.origin;
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.protocol !== 'https:' || url.host !== req.get('host')) throw new Error('Cross-origin');
      } catch (_) { return res.status(403).json({ error: 'Cross-origin request rejected.' }); }
    }
    if (!equalToken(req.headers['x-csrf-token'], req.session?.csrfToken)) {
      return res.status(403).json({ error: 'Missing or invalid CSRF token. Refresh the page.' });
    }
    next();
  };
}

module.exports = { readPublicSettings, publicRequestGuard };
