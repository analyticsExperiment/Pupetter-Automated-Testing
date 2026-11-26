const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readPublicSettings } = require('../src/auth/publicMode');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/tunnel');
const envPath = path.join(root, '.env.tunnel');
let app, tunnel, stopped = false;
const state = { launcherPid: process.pid, running: true };
const statePath = path.join(output, 'state.json');
function saveState() {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}
function stop() {
  if (stopped) return;
  stopped = true;
  tunnel?.kill('SIGTERM');
  app?.kill('SIGTERM');
  state.running = false;
  saveState();
  setTimeout(() => process.exit(process.exitCode || 0), 1000);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
async function main() {
  if (!fs.existsSync(envPath)) throw new Error('Run npm run share:setup first.');
  if (fs.statSync(envPath).mode & 0o077) throw new Error('.env.tunnel must be private (chmod 600 .env.tunnel).');
  process.loadEnvFile(envPath);
  const settings = readPublicSettings();
  if (!settings.enabled) throw new Error('Sharing requires FREE_AUDIT_PUBLIC_MODE=1.');
  const binary = process.env.CLOUDFLARED_PATH || path.join(output, 'bin/cloudflared');
  if (!fs.existsSync(binary)) throw new Error('Install the official cloudflared binary; set CLOUDFLARED_PATH if needed.');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const appLog = fs.openSync(path.join(output, 'app.log'), 'a', 0o600);
  const tunnelLog = fs.openSync(path.join(output, 'cloudflared.log'), 'a', 0o600);
  const port = Number(process.env.PORT || 3000);
  const origin = `http://127.0.0.1:${port}`;
  if (await fetch(`${origin}/api/auth/public-settings`, { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false)) {
    throw new Error(`Port ${port} is already serving an app. Stop it before sharing.`);
  }
  app = spawn(process.execPath, ['server.js'], { cwd: root, env: process.env, stdio: ['ignore', appLog, appLog] });
  state.appPid = app.pid;
  app.on('exit', (code) => { if (!stopped) { console.error(`App exited (${code}); see output/tunnel/app.log.`); process.exitCode = 1; stop(); } });
  let ready = false;
  for (let n = 0; n < 100 && !stopped; n++) {
    ready = await fetch(`${origin}/api/auth/public-settings`, {
      headers: { 'X-Forwarded-Proto': 'https' }, signal: AbortSignal.timeout(1000)
    }).then(async (response) => response.ok && (await response.json()).publicMode === true).catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Private-login server did not start; tunnel was not launched.');
  console.log('Private-login server ready; public signup disabled. Username:', settings.username);
  console.log('Password is stored in .env.tunnel; do not share SESSION_SECRET.');
  tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', origin], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe']
  });
  state.tunnelPid = tunnel.pid;
  saveState();
  let logTail = '';
  const capture = (chunk) => {
    fs.writeSync(tunnelLog, chunk);
    logTail = (logTail + chunk.toString()).slice(-10000);
    const url = (logTail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g) || [])
      .find((candidate) => new URL(candidate).hostname !== 'api.trycloudflare.com');
    if (url && state.url !== url) {
      state.url = url;
      saveState();
      console.log('Public login URL:', state.url);
      console.log('Keep this terminal and machine running. Ctrl+C stops both app and tunnel.');
    }
  };
  tunnel.stdout.on('data', capture);
  tunnel.stderr.on('data', capture);
  tunnel.on('error', (error) => { console.error(error.message); process.exitCode = 1; stop(); });
  tunnel.on('exit', (code) => { if (!stopped) { console.error(`Tunnel exited (${code}); see output/tunnel/cloudflared.log.`); process.exitCode = 1; stop(); } });
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; stop(); });
