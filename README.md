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

## Before deployment

Create a D1 database and replace both placeholder `database_id` values in `wrangler.jsonc` with the identifier returned by Wrangler:

```sh
npx wrangler d1 create incident-investigator
```

Then deploy with:

```sh
npm run deploy
```
