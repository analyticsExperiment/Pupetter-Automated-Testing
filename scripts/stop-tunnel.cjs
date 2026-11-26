const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const statePath = path.join(root, 'output/tunnel/state.json');
try {
  if (!fs.existsSync(statePath)) throw new Error('No sharing session is recorded.');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!state.running) { console.log('Sharing is already stopped.'); process.exit(0); }
  const pid = state.launcherPid;
  if (!Number.isInteger(pid) || pid < 2) throw new Error('Invalid sharing process record.');
  if (process.platform !== 'linux') throw new Error('On this platform, press Ctrl+C in the sharing terminal to stop.');
  const proc = `/proc/${pid}`;
  if (!fs.existsSync(proc)) { console.log('The recorded sharing launcher is no longer running.'); process.exit(0); }
  const args = fs.readFileSync(`${proc}/cmdline`, 'utf8').split('\0').filter(Boolean);
  const cwd = fs.realpathSync(`${proc}/cwd`);
  const script = args[1] && path.resolve(cwd, args[1]);
  if (cwd !== root || script !== path.join(root, 'scripts/start-tunnel.cjs')
    || fs.statSync(proc).uid !== process.getuid()) {
    throw new Error('Process identity does not match this sharing launcher; nothing was stopped.');
  }
  if (process.argv.includes('--check')) console.log('Verified the running sharing launcher; stop command is ready.');
  else { process.kill(pid, 'SIGTERM'); console.log('Stop requested for this app and tunnel.'); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
