const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { readPublicSettings } = require('../../src/auth/publicMode');
const root = path.resolve(__dirname, '../..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'free-audit-public-'));
  const password = randomBytes(24).toString('base64url');
  assert.throws(() => readPublicSettings({ FREE_AUDIT_PUBLIC_MODE: '1' }), /Public mode requires/);
  const blockedDb = path.join(temp, 'must-not-be-created.db');
  const blocked = spawnSync(process.execPath, ['server.js'], { cwd: root, encoding: 'utf8', env: {
    ...process.env, FREE_AUDIT_PUBLIC_MODE: '1', ADMIN_PASSWORD: 'audit123', SESSION_SECRET: 'audit-secret', FREE_AUDIT_DB_PATH: blockedDb
  } });
  assert.notEqual(blocked.status, 0);
  assert(!fs.existsSync(blockedDb), 'Unsafe startup must fail before opening a database');
  const dbPath = path.join(temp, 'audits.db');
  const initialize = spawnSync(process.execPath, ['-e', "const d=require('./src/db');const {hashPassword}=require('./src/auth/passwords');d.createUser({username:'admin',passwordHash:hashPassword('audit123')});d.createUser({username:'otheruser',passwordHash:hashPassword('OtherLocalPassword123!')});"], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FREE_AUDIT_PUBLIC_MODE: '0', FREE_AUDIT_DB_PATH: dbPath }
  });
  assert.equal(initialize.status, 0, initialize.stderr);
  const target = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Public mode QA</title><h1>Owned test fixture</h1><script>window.dataLayer=[{event:"qa-loaded"}];</script>');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const publicHost = `127.0.0.1:${port}`;
  const app = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, PORT: String(port), FREE_AUDIT_DB_PATH: dbPath, FREE_AUDIT_PUBLIC_MODE: '1',
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password, SESSION_SECRET: randomBytes(48).toString('hex')
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  app.stderr.on('data', (chunk) => { errors += chunk; });
  let cookie = '', csrf = '';
  async function call(route, options = {}, authenticated = true) {
    const headers = { 'X-Forwarded-Proto': 'https',
      'X-Forwarded-For': '198.51.100.5', ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...options.headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options = { ...options, body: JSON.stringify(options.body) };
    }
    return fetch(base + route, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...options, headers });
  }
  async function sessionToken() {
    const response = await call('/api/auth/csrf');
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      assert.match(setCookie, /Secure/);
      assert.match(setCookie, /HttpOnly/);
      cookie = setCookie.split(';')[0];
    }
    csrf = (await response.json()).csrfToken;
  }
  try {
    for (let n = 0; n < 80; n++) {
      if (await call('/api/health').then((response) => response.ok).catch(() => false)) break;
      if (app.exitCode !== null) throw new Error(errors);
      await delay(150);
    }
    assert.equal((await fetch(base + '/api/health')).status, 400, 'Direct HTTP is not a public login channel');
    assert.equal((await call('/', {}, false)).status, 302);
    assert.equal((await call('/%69ndex.html', {}, false)).status, 302);
    assert.equal((await call('/api/audits', {}, false)).status, 401);
    assert.equal((await call('/api/agent/schema', {}, false)).status, 401);
    assert.equal((await call('/register', {}, false)).status, 403);
    const html = await (await call('/login', {}, false)).text();
    assert(!html.includes('audit123') && !html.includes('Sign Up'));
    const settings = await (await call('/api/auth/public-settings')).json();
    assert.equal(settings.registrationEnabled, false);
    assert.equal(settings.logTransport, 'poll');
    assert.equal((await call('/auth/login', { method: 'POST', body: { username: 'admin', password } })).status, 403);
    await sessionToken();
    console.log('Public startup, anonymous access, and login form checks passed.');
    const mutation = (route, body, extraHeaders = {}) => call(route, { method: 'POST', body,
      headers: { 'X-CSRF-Token': csrf, Origin: `https://${publicHost}`, ...extraHeaders } });
    assert.equal((await mutation('/auth/register', { username: 'outsider', password: 'ValidButNotApproved123!' })).status, 403);
    const defaultLogin = await mutation('/auth/login', { username: 'admin', password: 'audit123' });
    assert.equal(defaultLogin.status, 401, await defaultLogin.text());
    assert.equal((await mutation('/auth/login', { username: 'otheruser', password: 'OtherLocalPassword123!' })).status, 401);
    assert.equal((await mutation('/auth/login', { username: 'admin', password }, { Origin: 'https://evil.invalid' })).status, 403);
    const login = await mutation('/auth/login', { username: 'admin', password });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    await sessionToken();
    assert.equal((await call('/api/audits')).status, 200);
    assert.equal((await call('/api/audit-configs')).status, 200);
    assert.equal((await call('/api/audit/missing/logs?transport=poll')).status, 404);
    const createdToken = await mutation('/api/extension/tokens', { label: 'Public QA token' });
    assert.equal(createdToken.status, 201);
    const token = (await createdToken.json()).token;
    assert(token);
    assert.equal((await call('/api/extension/status', { headers: { Authorization: `Bearer ${token}` } }, false)).status, 200);
    console.log('Private login, CSRF, saved configurations, and extension access checks passed.');
    const started = await mutation('/api/audit/start', { domain: `http://127.0.0.1:${target.address().port}`,
      maxPages: 1, headless: true, waitUntil: 'domcontentloaded', autoDismissConsent: false });
    assert.equal(started.status, 200, await started.clone().text());
    const { id } = await started.json();
    assert(id);
    console.log('Owned fixture audit started; checking log polling and report completion.');
    let completed, cursor = 0, logCount = 0;
    for (let n = 0; n < 120; n++) {
      const response = await call(`/api/audit/${id}/logs?transport=poll&after=${cursor}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/json/);
      const page = await response.json();
      for (const log of page.logs) assert(log.seq > cursor);
      cursor = page.cursor;
      logCount += page.logs.length;
      if (page.status === 'failed') throw new Error('Fixture audit failed: ' + page.error);
      if (page.status === 'completed' && !page.hasMore) { completed = page; break; }
      await delay(250);
    }
    assert(completed, 'One-page fixture audit must complete');
    assert(logCount > 0, 'Polling must deliver audit logs');
    const replay = await (await call(`/api/audit/${id}/logs?transport=poll&after=${cursor}`)).json();
    assert.equal(replay.logs.length, 0, 'Cursor must prevent duplicate log delivery');
    const result = await (await call(`/api/audit/${id}/results`)).json();
    assert.equal(result.pages.length, 1);
    for (let n = 0; n < 40; n++) assert.equal((await call('/api/auth/csrf', {
      headers: { 'X-Forwarded-For': '198.51.100.77' }
    }, false)).status, 200);
    assert.equal((await call('/api/auth/csrf', { headers: { 'X-Forwarded-For': '198.51.100.77' } }, false)).status, 429);
    const logout = await mutation('/auth/logout', {});
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /audit\.public\.sid=;/);
    assert.equal((await call('/api/audits')).status, 401);
    console.log(JSON.stringify({ passed: true, checks: ['fail-closed startup', 'loopback/HTTPS policy',
      'secure cookies', 'anonymous API blocked', 'registration disabled', 'default/stored passwords rejected',
      'CSRF/cross-origin enforcement', 'authenticated configs/reports', 'extension bearer access',
      'one-page browser audit', 'live log polling without duplicates', 'login rate limit'], logCount, temporaryDatabaseOnly: true }, null, 2));
  } finally {
    app.kill('SIGTERM');
    await new Promise((resolve) => { if (app.exitCode !== null) resolve(); else app.once('exit', resolve); });
    await new Promise((resolve) => target.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
