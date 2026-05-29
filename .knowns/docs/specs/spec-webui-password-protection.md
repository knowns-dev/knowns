---
title: 'Spec: WebUI Password Protection'
description: Spec for in-memory password protection with CLI flag and WebUI login gate
createdAt: '2026-05-28T08:44:46.846Z'
updatedAt: '2026-05-28T08:44:46.846Z'
tags:
  - spec
  - auth
  - password
  - webui
  - security
---

# Spec: WebUI Password Protection (In-Memory)

## Overview

Allow users to protect WebUI access with a password. Password is stored in-memory only (never persisted to disk). Can be set via CLI `--password` flag or from WebUI settings at runtime.

## Background

- Server currently has ZERO auth — no middleware, no session, no cookies (`internal/server/server.go:860-917`)
- Frontend SPA served via embedded FS with fallback to `index.html` (`internal/server/server.go:1245-1293`)
- CORS allows all origins (`internal/server/server.go:872-880`)
- No existing session/cookie handling anywhere in the server

## Requirements

### CLI Flag

- `knowns browser --password "secret"` — server starts with password protection active
- Password passed to server via `Options` struct (`internal/server/server.go:50-52`)
- CLI prints on start:
  ```
  🔒 Password protection active
  ```

### WebUI Settings (Runtime Set)

- Add "Security" section in ConfigPage settings
- Password input field + "Set Password" button
- When password is set: show status "Protected" with option to remove
- When no password: show "Unprotected" with warning if tunnel is active
- After setting password from UI: caller gets session cookie automatically (not locked out)

### API Endpoints

- `POST /api/auth/password` `{ password: "..." }` — set password in-memory, returns session cookie
- `DELETE /api/auth/password` — remove password protection (requires valid session)
- `POST /api/auth/login` `{ password: "..." }` — authenticate, returns session cookie
- `GET /api/auth/status` — returns `{ protected: bool, authenticated: bool }`

### Auth Middleware

- Chi middleware inserted BEFORE all routes (including static UI)
- If no password set → pass through (no-op)
- If password set → check for valid session cookie
- Invalid/missing session → return 401 with JSON `{ error: "unauthorized", loginRequired: true }`
- Exception: `POST /api/auth/login` and `GET /api/auth/status` always accessible (no auth required)

### Login Gate (Frontend)

- When API returns 401 with `loginRequired: true` → show full-screen login overlay
- Simple form: password input + submit button
- On success: overlay disappears, app loads normally
- On failure: show error message, stay on login screen
- Session persists via cookie (survives page refresh, not server restart)

### Session Management

- Session = random token stored in-memory map on server
- Cookie: `knowns_session=<token>`, HttpOnly, SameSite=Lax, Path=/
- Sessions cleared on server restart (by nature of in-memory)
- No expiry (session lives until server restart or password removal)

### CLI Status Output

- When password is set (from any source): print to CLI terminal
  ```
  🔒 Password protection enabled
  ```
- When password is removed: print
  ```
  🔓 Password protection disabled
  ```

### Error Handling

- Empty password → reject with 400
- Wrong password on login → 401, no timing side-channel (constant-time compare)
- Remove password without valid session → 401

## Security Considerations

- Use `crypto/subtle.ConstantTimeCompare` for password verification
- Password stored as-is in memory (no hashing needed since it's ephemeral and in-memory)
- Session tokens generated with `crypto/rand` (32 bytes, hex-encoded)
- No rate limiting needed for v1 (in-memory, single-user context)

## Non-Goals

- Persisting password to disk or config.json
- User accounts / multi-user auth
- OAuth / SSO
- Password hashing (ephemeral in-memory, no persistence)
- Forcing password when tunnel is active (user's choice — separate features)

## Acceptance Criteria

- [ ] `knowns browser --password "x"` starts server with auth active
- [ ] WebUI shows login overlay when password is set and session invalid
- [ ] User can login with correct password
- [ ] Wrong password shows error, does not grant access
- [ ] User can set password from WebUI settings (runtime)
- [ ] User who sets password gets auto-authenticated (not locked out)
- [ ] User can remove password from WebUI settings
- [ ] CLI prints status when password is set/removed
- [ ] Page refresh preserves session (cookie)
- [ ] Server restart clears all sessions and password
- [ ] Auth middleware protects all routes including static assets
- [ ] `/api/auth/login` and `/api/auth/status` accessible without auth
