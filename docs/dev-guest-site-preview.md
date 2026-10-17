# MZ guest-site local preview lifecycle

This preview is intentionally on demand. It does not install a LaunchAgent, add a login item, start at boot, keep a supervisor running, or poll service/database health after startup. A session-local idle monitor stops the preview after exactly five minutes without real browser activity.

## Finder workflow

From the repository folder, double-click:

1. `Start MZ Preview.command` — validates the enrolled `MZ-Dev-Preview` environment, starts the three local services and one loopback-only idle monitor, waits for one bounded startup-readiness check, and opens the selected property page.
2. `Stop MZ Preview.command` — stops only recorded processes and listeners whose working directory belongs to this repository. It then confirms that ports 3004, 3006, 4012 and 4013 are released.

Optional: `MZ Preview Status.command` only inspects local PIDs, working directories and listening ports. It does not make an HTTP request or query the database.

Double-clicking Start again is idempotent: if all three recorded processes and ports still exist, it opens the preview without creating duplicates. A partial/stale local run is stopped only when every occupied target port can be attributed to this repository; an unrelated owner makes startup fail closed.

## Five-minute inactivity stop

- Booking on 3004 and admin on 3006 share one session deadline. Pointer/click, keyboard, input, scroll, focus/return-to-tab and route changes extend that deadline through the local activity monitor on `127.0.0.1:4013`.
- Reports are throttled and contain only the session identity and activity time. They never contain a key, input value, field name or page content. The ephemeral token is held only in the running child processes/browser bundle and is not written to the state file.
- HMR, ordinary fetches, startup health checks and backend/database activity do not extend the deadline. The warning status request about 30 seconds before expiry also does not extend it.
- With every page closed, the in-memory timer still expires and stops 3004, 3006 and 4012. The monitor then exits too. Double-click Start to begin a new five-minute session.
- Manual Stop cancels the current timer immediately. A monitor from an older session must match both the current session ID and monitor PID before it may stop anything, so it cannot terminate a newer Start session.

## Local addresses

- Booking/property preview: `http://127.0.0.1:3004/properties/233a33d3-5a77-4b53-b6ae-8d806f9ea2d4`
- Admin login: `http://127.0.0.1:3006/login`
- Development backend: `http://127.0.0.1:4012`
- Local activity monitor: `http://127.0.0.1:4013` (session-authenticated; no business API)

All four bind to `127.0.0.1`; the scripts do not expose them on the LAN or internet.

## Database and background-work boundary

- Start accepts only the previously enrolled DEV database identity and rejects production app/role, production identity fallback, a non-loopback bind, enabled runtime DDL, or any enabled write/background worker.
- Backend startup uses `STARTUP_WARMUP_MODE=readonly`. It performs the existing fixed migration-marker reads and one readiness `SELECT 1`; it does not run migrations. The two legacy module-import DDL warmups are disabled for this preview process.
- Email sync/watchdog, notifications, cleaning sync/event/retry/backfill, job pruning, key/reminder jobs, personnel settlement, cleaning feature work and PDF jobs are disabled.
- After startup there is no lifecycle health timer or database polling. The idle monitor receives only throttled browser-activity timestamps and never calls the backend or database. Normal page/API requests still read the DEV database as needed.
- The backend uses a PostgreSQL pool capped at two connections. A connection used during startup or a page request may remain idle for up to 30 seconds before the pool releases it; therefore “the backend is running” is not the same as “the database is never connected.” Double-click Stop to terminate the backend and its pool completely when the preview is not in use.

## Commands and logs

The Finder files wrap these project commands:

```text
npm run dev:guest-site:start
npm run dev:guest-site:stop
npm run dev:guest-site:restart
npm run dev:guest-site:status
npm run dev:guest-site:logs
```

Local state and logs are stored under `.dev-preview/guest-site-services/`, which is ignored by Git. The state contains only workspace, session ID, PIDs, ports and timestamps; it does not store the activity token, database URLs or credentials. The log reader redacts database URLs and token query parameters.

## Limits and rollback

- There is no automatic recovery after Mac shutdown, sleep, a crashed service or a source error. Double-click Start to restore the preview.
- This is localhost on the Mac; it is not an iPhone-accessible or publicly hosted URL.
- To disable the workflow, double-click Stop. No system service, login item, firewall, VPN, power or DNS setting needs removal.
