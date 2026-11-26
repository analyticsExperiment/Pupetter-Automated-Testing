const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env.tunnel');

async function main() {
  const output = path.join(root, 'output/tunnel');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const dbPath = path.join(root, 'data/audits.db');
  if (fs.existsSync(dbPath) && !fs.existsSync(path.join(output, 'backup-manifest.json'))) {
    const backupDir = fs.mkdtempSync(path.join(output, 'backup-'));
    fs.chmodSync(backupDir, 0o700);
    const db = new Database(dbPath, { readonly: true });
    try {
      const backupPath = path.join(backupDir, 'audits.db');
      await db.backup(backupPath);
      fs.chmodSync(backupPath, 0o600);
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const counts = Object.fromEntries(tables.map(({ name }) => [name,
        db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get().n]));
      fs.writeFileSync(path.join(output, 'backup-manifest.json'), JSON.stringify({ backupPath, counts }, null, 2), { mode: 0o600, flag: 'wx' });
      console.log('Existing database backed up privately; account passwords and history were not changed.');
    } finally { db.close(); }
  }
  if (!fs.existsSync(envPath)) {
    const contents = [
      '# Private tunnel-only credentials. Never commit or share this entire file.',
      '# The stored local admin password and audit data are not modified.',
      'FREE_AUDIT_PUBLIC_MODE=1', 'ADMIN_USERNAME=admin',
      `ADMIN_PASSWORD=${crypto.randomBytes(24).toString('base64url')}`,
      `SESSION_SECRET=${crypto.randomBytes(48).toString('hex')}`,
      'PORT=3000', ''
    ].join('\n');
    fs.writeFileSync(envPath, contents, { flag: 'wx', mode: 0o600 });
  }
  fs.chmodSync(envPath, 0o600);
  console.log('Private credentials file: .env.tunnel (owner-readable only; no secret printed).');
  console.log('Start: npm run share. Stop: Ctrl+C in the sharing terminal.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
