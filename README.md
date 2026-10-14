# Agent Break Dashboard

Source for the [live Agent Break Dashboard](https://agent-break-dashboard-live.vercel.app/). This folder is the Vercel project root. The static dashboard is in `index.html` and `datepicker.js`; its server functions are in `api/`.

## Environment variables

Copy `.env.example` to `.env.local` for local development and fill in your own values. **Only variable names and empty placeholders belong in Git.** Add actual values in Vercel's project environment settings for deployments. The existing Vercel project already has its own environment settings; connecting Git does not require committing or re-entering credentials.

| Variable | Purpose |
| --- | --- |
| `OZONETEL_API_KEY` | Ozonetel CloudAgent API key for agent status and reports. |
| `OZONETEL_USERNAME` | CloudAgent account username associated with the key. |
| `OZONETEL_WEBHOOK_SECRET` | Secret used to authenticate the Ozonetel agent-event webhook. |
| `KV_REST_API_URL` | Upstash Redis REST endpoint for retained break events. |
| `KV_REST_API_TOKEN` | Upstash Redis REST token. |
| `OZONETEL_AGENT_IDS` | Optional comma-separated agent IDs to include before their first call. |
| `OZONETEL_MODE_TYPES` | Optional mode filter for Ozonetel state summary. |

If the account uses a different CloudAgent API host, set optional `OZONETEL_BASE_URL` (or `OZONETEL_DOMAIN`).

## Deployment

Connect the GitHub repository to the existing Vercel project `agent-break-dashboard-live`, with this folder as the repository root. Pushes to the production branch then build the dashboard from Git. Keep the project's current environment variables and Upstash integration so its live break history remains available.

The Ozonetel agent-event webhook posts to `/api/agent-event?key=<OZONETEL_WEBHOOK_SECRET>`. Preserve its existing secret and target URL when connecting Git. Historical break events from 26 September 2026 onward are retained in Redis. The bundled `data/break-details.json` supplies 364 older records from 19–25 September 2026 and contains agent names and IDs, so use a private GitHub repository unless that information is intended to be public.

`api/report.js` also reads archived call records from `https://sunrooof-agent-calls-20260923.vercel.app/api/calls` when needed. That separate service is an external dependency of this dashboard.
