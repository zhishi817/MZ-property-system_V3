# Dev Workflow

## Start

- Run `npm run dev` from the repository root.
- The root script starts `backend` first.
- The frontend starts only after `http://localhost:4002/health` is ready.

## Default Ports

- Frontend: `3000`
- Backend: `4002`

## Auto Reload

- Frontend uses `next dev` and hot reloads normal page and component changes.
- Backend uses `ts-node-dev --respawn` and restarts automatically on normal route and service changes.

## Login State in Dev

- When the local backend briefly restarts, the frontend will try to keep the current login state.
- During recovery, the header shows a reconnecting message instead of immediately redirecting to `/login`.

## Manual Restart Still Needed

- After changing `frontend/next.config.js`
- After changing `.env.local` or other environment variables
- After installing new dependencies
- After changes that affect Node startup parameters or build configuration
