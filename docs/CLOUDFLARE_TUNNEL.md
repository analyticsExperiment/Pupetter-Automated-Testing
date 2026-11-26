# Share the local app through Cloudflare

This setup runs the full app on the host computer and exposes a temporary HTTPS URL through a Cloudflare Quick Tunnel. No Cloudflare account or domain is required. Visitors see the login screen; a URL alone does not grant access to audit data.

Use this for temporary sharing with trusted colleagues, not unattended production hosting. The app uses an in-memory session store, so restarting logs everyone out. The host must remain awake, online, and running both processes. The hostname changes when a new tunnel starts. [Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## One-time preparation

1. Install the app dependencies as described in the main README. Node.js 24 is recommended for these scripts (`process.loadEnvFile` is used).
2. Obtain `cloudflared` from the [official downloads page](https://developers.cloudflare.com/tunnel/downloads/). Place the appropriate binary at `output/tunnel/bin/cloudflared`, or set `CLOUDFLARED_PATH` to its location. On Linux/macOS, make the binary executable. This project's host uses the checksum-verified Linux AMD64 2026.10.0 release; that binary is local and is not included in the source repository.
3. Run:

   ```bash
   npm run share:setup
   ```

This creates a private, Git-ignored `.env.tunnel` containing a random sharing password and session secret. On Linux/macOS the file must be owner-readable only (mode `600`). If the existing `data/audits.db` is present, preparation also makes a private SQLite online backup under `output/tunnel/`; its path and record counts are recorded in `backup-manifest.json`. Repeating preparation preserves the existing credentials and backup.

## Start and stop

Stop any normal app already using port 3000, then run:

```bash
npm run share
```

The script starts the protected app on `127.0.0.1`, waits for it to become ready, then starts the tunnel. It prints an `https://...trycloudflare.com` URL. Use this URL even on the host computer while sharing; direct HTTP is deliberately rejected in sharing mode.

Keep the sharing terminal open. Press **Ctrl+C** there to stop both the app and the tunnel. On this Linux host, you can also stop sharing from another terminal in the app directory:

```bash
npm run share:stop
```

The stop script verifies the recorded launcher's process identity before signalling it, avoiding an unrelated process if the record is stale. On macOS/Windows use Ctrl+C in the sharing terminal. No boot service or automatic restart is installed. Private logs and process state are in `output/tunnel/`.

## Login and access

- Username: the `ADMIN_USERNAME` value in `.env.tunnel` (initially `admin`).
- Password: the `ADMIN_PASSWORD` value in `.env.tunnel`. Share only that password privately with trusted users; **never share the whole file or `SESSION_SECRET`**.
- The sharing password overrides the configured admin's password only for this running public instance. It does not rewrite any stored account password or move audit data.
- Public signup is disabled. Other existing local usernames cannot sign into this sharing instance. Normal local mode keeps its existing login behaviour.
- A signed-in user has full access to that admin account's configuration, audit history, and features; this is not a read-only viewer account.
- HTTPS-only, secure HttpOnly cookies, same-origin CSRF checks, and a login-request rate limit are enabled. Sessions last at most two hours and end when the app restarts. Use logout on shared devices.
- Rotating the sharing password/session secret requires stopping the app, privately editing `.env.tunnel`, and restarting it. A restart also changes the temporary URL. Extension bearer tokens are separate credentials: revoke unwanted tokens in app settings; rotating the password alone does not revoke them.

Only the login assets and non-sensitive health/sharing metadata are available anonymously. Configuration, reports, exports, and account APIs require authentication. Browser extensions use individually revocable pairing tokens.

## Connect the Chrome extension

1. Reload the updated unpacked extension in `chrome://extensions` and refresh any previously opened app tabs.
2. Set the extension's **Free Audit app URL** to the current public HTTPS tunnel URL, rather than `http://localhost:3000` on a colleague's machine.
3. Choose **Sign in via app**, sign in with the sharing credentials, and connect the extension. The connection flow requests a CSRF token before creating a pairing token.
4. Saved configurations are fetched from the same host database. No manual configuration export is needed. Audit browsing takes place in that colleague's Chrome; server-launched Puppeteer/Playwright audits still run on the host computer.
5. When the tunnel URL changes, update the extension app URL and reconnect. An extension token remains sensitive until revoked.

The updated connection code is included in `extension/free-audit-recorder/contentScript.js`. A colleague using an older extension copy must replace/reload it; an unpacked extension does not update itself from this repository automatically. This setup does not install the extension into anyone's Chrome.

## Live progress and verification

Quick Tunnels do not support Server-Sent Events (SSE). Sharing mode selects short authenticated HTTP polls for audit and interaction logs; normal local mode retains SSE. A log cursor prevents duplicate delivery. [Cloudflare limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations).

Run the isolated regression before sharing:

```bash
npm run qa:public-mode
```

It uses a disposable SQLite database and an owned local test site, checking fail-closed startup, HTTPS/cookies, anonymous access, signup restrictions, rejected old/default passwords, CSRF, extension bearer authentication, a one-page browser audit, polling, logout, and rate limiting. It does not audit an external customer website or write test records into the real database.

## Troubleshooting

- **Port is already serving an app:** stop the existing app first; the launcher will not attach a tunnel to an unknown process.
- **Private file permissions error:** on Linux/macOS run `chmod 600 .env.tunnel`.
- **Public mode requires HTTPS:** open the printed HTTPS tunnel URL, not local HTTP. Only the loopback proxy is trusted to report HTTPS.
- **429 at login:** wait for the ten-minute login window to expire. Cloudflare also has its own concurrent-request limits.
- **Tunnel URL no longer opens:** check the host's internet/sleep state and the sharing terminal. Restart if necessary and share the newly printed URL.
- **Extension connection fails:** reload the updated extension, use the current HTTPS app URL, and reconnect through the app. Do not paste session cookies or the session secret into the extension.

For a stable hostname, persistent hosting, individual user roles, and stronger access controls, use a Cloudflare account and a named tunnel with an appropriate production deployment. This temporary setup does not provide those guarantees.
