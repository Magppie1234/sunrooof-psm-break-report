# Agent Break Dashboard

Source for the [live Agent Break Dashboard](https://agent-break-dashboard-live.vercel.app/). This folder is the Vercel project root. The static dashboard is in `index.html` and `datepicker.js`; its server functions are in `api/`.

## Environment variables

Copy `.env.example` to `.env.local` for local development and fill in your own values. **Only variable names and empty placeholders belong in Git.** Add actual values in Vercel's project environment settings for deployments. The existing Vercel project already has its own environment settings; connecting Git does not require committing or re-entering credentials.

| Variable | Purpose |
| --- | --- |
| `PSM_INTEGRATION_URL` | Existing shared Ozonetel reporting service. |
| `PSM_INTEGRATION_KEY` | Server-only key for the existing shared service. |
| `OZONETEL_USERNAME` | CloudAgent account username associated with the shared service. |
| `OZONETEL_WEBHOOK_SECRET` | Secret used to authenticate the Ozonetel agent-event webhook. |
| `KV_REST_API_URL` | Upstash Redis REST endpoint for retained break events. |
| `KV_REST_API_TOKEN` | Upstash Redis REST token. |
| `OZONETEL_AGENT_IDS` | Optional comma-separated agent IDs to include before their first call. |
| `OZONETEL_MODE_TYPES` | Optional mode filter for Ozonetel state summary. |

The dashboard preserves the shared reporting connection deployed in October. It does not generate provider tokens or bypass the shared service with direct provider requests.

## Deployment

This repository is connected to the existing Vercel project `agent-break-dashboard-live`, with the repository root as its project root. Pushes to the `main` production branch build the dashboard from Git. Keep the project's current environment variables and Upstash integration so its live break history remains available.

The Ozonetel agent-event webhook posts to `/api/agent-event?key=<OZONETEL_WEBHOOK_SECRET>`. Preserve its existing secret and target URL. Historical break events from 26 September 2026 onward are retained in Redis. The bundled `data/break-details.json` supplies 364 older records from 19–25 September 2026 and contains agent names and IDs.

## Counts, durations, and data quality

Named break totals exclude SIP disconnections, mode changes, refresh, reconnect, and other recognized system events, even when those entries are selected for inspection. Refresh and changeMode remain unticked by default. Unknown reasons are not presented as named breaks.

Break history is reconstructed from retained Ozonetel agent events. Repeated notifications for the same active reason do not create extra breaks. A changed reason starts a new interval. Explicit ready/call/logout transitions end an interval; unrelated notifications do not. Saved baseline rows are reconciled per agent without using another agent's cutoff or counting overlapping intervals twice.

Historical entries without an end event are marked incomplete and excluded from duration totals. Current provider status that contradicts an apparently open event also marks the interval incomplete; an end time is never invented. A paused agent missing a start event has an incomplete-history marker rather than a fabricated AUX start. Newer events can update a provider status snapshot, and the original provider sample time remains visible. Cached data never receives a new sample timestamp merely because the page refreshes.

All times are interpreted in IST unless their source explicitly includes a timezone. Cross-midnight intervals are clipped to the selected date. Agent rows, break-type summaries, detail views, and CSVs use the same filtered records. Missing upstream events cannot be recreated without an original Ozonetel report; affected figures are labeled as recorded/incomplete.

Run the regression checks with `node --test test/*.test.cjs`.
