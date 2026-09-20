# Incident Investigator

Foundation for an AI-powered incident investigation demo built with React, TypeScript, Cloudflare Workers, D1, and Workers AI.

## Local development

```sh
npm install
npm run dev
```

The React application is served by the Worker. `GET /api/health` confirms that the local Worker has its D1 binding available.

Workers AI runs remotely, so it is enabled only in the production Worker environment. This keeps the local scaffold runnable without Cloudflare credentials. The app does not call a model yet, so it has no inference behavior or associated feature logic.

## Local database

Apply pending D1 migrations to the local database:

```sh
npm run db:migrate:local
```

Verify that the four application tables exist:

```sh
npm run db:verify:local
```

## Simulated production data

The Worker combines three JSON fixture files into one deterministic simulated production environment. They contain separate logs, metrics, traces, recent deployments, and service-health observations—never a stored root-cause field or a user-selectable scenario.

The data includes clues for checkout 500s, payment failures caused by database connection pressure, and European order timeouts. It is internal observability data: the user only describes what they see, and the future LLM decides which tools to call.

The investigation tool layer is in `worker/tools.ts`. It exposes five small operations that will later be supplied to the LLM:

- `searchLogs` searches across the environment by service, region, query text, and time range.
- `getMetrics` returns a requested metric series for a service and optional region.
- `getServiceHealth` returns a compact degraded-service overview with no filters, or filtered health checks when a service or region is supplied.
- `getRecentDeployments` returns recent deployments across the environment, newest first.
- `getTrace` returns one trace by ID.

Run the fixture and tool tests with:

```sh
npm test
```

## Before deployment

Create a D1 database and replace both placeholder `database_id` values in `wrangler.jsonc` with the identifier returned by Wrangler:

```sh
npx wrangler d1 create incident-investigator
```

Then deploy with:

```sh
npm run deploy
```
