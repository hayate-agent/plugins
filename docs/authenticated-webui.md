# Explicit authenticated HTTPS WebUI (development)

The optional `identity/` backend owns single-operator authentication independently
of WebUI. The WebUI owns TLS/HTTP projection, the login form and the secure cookie.
It does not store passwords, password hashes or bearer tokens in browser storage,
project state or transcripts. Neither package changes live networking automatically.
This separately installed overlay requires Core's foreground-work contract and
version-1 service registry. It checks those capabilities on activation; no exact
Core or overlay revision pin or inclusion in Core's release assets is required.

## Bootstrap locally, not through an agent conversation

In an operator terminal (password entry is hidden):

```sh
node /opt/hayate-plugins/identity/setup.mjs /absolute/agent-home admin
```

This creates a private `identity.json` with a salted scrypt password verifier.
The setup refuses to overwrite existing configuration. Never paste the password
into a chat, model tool, command argument, Git remote or shell history. The identity
plugin requires a mode-0600, operator-owned regular file, refusing symlinks and
hard links. Private host filesystem custody remains necessary; this is not an
isolation boundary against unrestricted tools running as the same OS user.

Load identity before the WebUI gateway starts:

```yaml
plugins:
  - /opt/hayate-plugins/identity/index.mjs
  # other headless backend plugins as needed
```

The current principal is deliberately `operator`: this is authenticated remote
access to an existing single-operator agent, **not multiuser hosting**. Login names
do not introduce separate permissions or identities. Legacy conversations, project
commands and secret entries retain their existing operator ownership.

## Configure TLS only after explicit operator approval

An operator must supply DNS, a valid certificate/private key, firewall/port routing
and an explicit network configuration. Development and installation do none of these.
Example `<home>/webui-network.json`:

```json
{
  "host": "0.0.0.0",
  "origin": "https://agent.example.org:3210",
  "keyFile": "/absolute/private/tls/key.pem",
  "certFile": "/absolute/tls/fullchain.pem"
}
```

The listener still uses `HAYATE_WEBUI_PORT` (default 3210). The bind host must be a
literal IP. `origin` must be a canonical HTTPS origin with no userinfo/path/query.
Use a certificate valid for that hostname and an operator-owned mode-0600 regular
private key. Symlink TLS files are refused: copy/atomically replace renewed PEMs
at the configured regular-file paths and restart through normal host admission.
TLS configuration is validated before presentation modules acquire resources.
No runtime ACME client, DNS changes, reverse-proxy trust or certificate-reload loop
is installed. An absent network file preserves the existing unauthenticated exact
`127.0.0.1` local-only listener. An invalid file, missing identity service or unsafe
TLS key **fails startup**, never falls back to anonymous network access.

Direct TLS is required; the application does not infer authentication, TLS, authority
or client IP from `Forwarded` / `X-Forwarded-*` headers. Keep public exposure disabled
until overlay compatibility, operator configuration and deployment checks have been reviewed.
Do not put a public HTTP-terminating proxy in front of legacy loopback mode.

## Security behavior

- Every API and SSE route is authenticated in network mode, including capability,
  directory, project, credential and agent endpoints. Only static login assets and
  `/api/auth` are public. Login/logout mutations still require exact Origin and
  the WebUI custom header. No CORS grants exist.
- Authority must exactly match the configured canonical origin. Cross-site fetch
  metadata is refused; arbitrary forwarded-user/proto headers have no authority.
- Password checks use scrypt and constant-time verifier comparison, with bounded
  concurrent derivations and bounded per-socket-IP rate-limit state. The supplied
  username has no effect on client rate limiting. Passwords are never logged.
- Sessions use random 256-bit opaque tokens, stored only as hashes server-side.
  Cookies are `__Host-` scoped with `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`
  and expiry. They are audience-bound to the canonical HTTPS origin. The browser
  cannot retrieve tokens through JavaScript or a JSON authentication response.
- Default idle lifetime is one hour; `sessionLifetimeMs` in `identity.json` can be
  explicitly configured between one second and 24 hours. `POST /api/auth/renew`
  extends a valid session and refreshes its secure cookie. The compatible WebUI
  renews on trusted, visible user interaction at most once a minute; polling and
  SSE do not extend idle time. Very short configured lifetimes below that cadence
  can still expire during use.
- Session hashes and expiries persist in private `<home>/identity/account.json`
  and survive regular backend restarts. Existing memory-only sessions need one
  new login after upgrading. Logout durably revokes the token before expiring the
  cookie and clearing this application's pending browser drafts.
- Revocation/expiry prevents further SSE data immediately at projection time and
  closes idle streams within the two-second server maintenance interval. HTTP
  mutation body parsing rechecks authentication after upload. The UI locks when
  expiry is detected and never automatically retries productive submissions.
- Identity password derivations and session writes reserve host foreground
  admission and are drained on stop. Stopped instances reject authentication;
  unexpired persisted sessions remain valid on the next activation.

For routine changes use **Account settings** in the sidebar: choose login name and
optional new password, confirm the current password and save. Changes persist in
private `<home>/identity/account.json`, take precedence over the installation's
bootstrap `identity.json`, and revoke all existing sessions. The operator principal
and ownership of projects/credentials do not change when the login name changes.
Changes affect this dashboard instance, not accounts on paired targets. No passwords
enter chat, model tools, browser storage or API responses. Write failures retain the
prior credentials and live sessions.

Local recovery after a forgotten password is an operator-controlled maintenance
operation: stop normally, replace private bootstrap configuration, remove/reset the
private account override intentionally and restart. There is no anonymous recovery
API or password reset through a chat command. Kubernetes init must restore private
mode on retained `identity/account.json` if fsGroup broadens it at mount time.

## Verification

```sh
node --test identity/test/*.test.mjs
node --import ../core/node_modules/tsx/dist/loader.mjs identity/test/host.mjs ../core
npm test --prefix webui
npm run test:browser --prefix webui
```

Tests generate temporary self-signed certificates bound only to loopback; certificate
verification exceptions are test-only. The Chromium flow checks login, cookie
custody, absence of browser-stored credentials and revoked access after logout.
HTTP tests cover missing authentication across endpoint families, CSRF, rebinding,
forwarded-header spoofing, duplicate cookies, expiry, unsafe TLS configuration and
revocation of both legacy and workspace SSE. No live endpoint is opened or changed.
