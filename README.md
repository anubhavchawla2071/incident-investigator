# Incident Investigator

An AI-powered incident investigation console built for the Cloudflare take-home assignment.

A user reports a symptom such as “Checkout API is returning 500 errors in us-east-1.” The application creates an incident, runs a bounded investigation against simulated production data, and returns a diagnosis with cited evidence.

## Architecture

| Concern | Implementation |
| --- | --- |
| User interface | React + TypeScript incident console |
| API/runtime | Cloudflare Worker |
| Coordination | Cloudflare Workflow (`IncidentInvestigationWorkflow`) |
| Persistent state | Cloudflare D1 |
| LLM | Workers AI, using Llama 3.3 in production |
| Local/test model | Deterministic fixture model |
| Observability | Deterministic JSON fixtures and a bounded tool layer |

```text
React UI
   │ create incident / poll incident state
   ▼
Cloudflare Worker ──► D1 (incident, messages, tool runs, report)
   │
   ▼
Cloudflare Workflow
   │ initial health triage, tool validation, persistence
   ▼
Workers AI / Llama 3.3 ──► bounded observability tools ──► fixture data
   │
   ▼
Structured report with cited tool-run IDs
```

The Worker creates the incident and starts the Workflow. The Workflow owns coordination and durable progress: it records the initial service-health check, persists every tool run, validates the model’s requests, and saves the final report. D1 holds application state; it is not used as a fake log warehouse.

## How the investigation works

The model never receives all logs, metrics, traces, or deployments at once. It receives only:

- the user’s symptom;
- a small service catalog and degraded-service health overview;
- the available follow-up tool schemas and metrics for each service;
- results from completed tool calls; and
- controlled policy feedback when a request is invalid.

The model decides what to inspect next. The server keeps that loop safe and bounded by validating tool inputs, normalizing harmless aliases, rejecting unavailable metrics, rejecting invented trace IDs and exact duplicate calls, applying an explicit user-service scope when relevant, and enforcing the six-call budget. The initial `getServiceHealth` call is workflow-owned triage; the model uses it to choose subsequent evidence.

The simulated tools behave like small observability APIs:

- `searchLogs` searches bounded log records.
- `getMetrics` returns one metric series for a service and region.
- `getTrace` fetches one observed trace ID.
- `getRecentDeployments` lists recent deployments for a service/region.
- `getServiceHealth` provides the workflow’s initial degraded-service overview.

The fixtures contain clues, not a stored answer or scenario key. The final model call receives a compact evidence summary and the actual tool-run IDs it is allowed to cite, then returns `resolved` or `inconclusive`, a diagnosis, root cause, confidence, next steps, and cited evidence.

## Local development

```sh
npm install
npm run db:migrate:local
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:5173`). The local console uses the deterministic model, so it does not require Workers AI credentials.

Useful local commands:

```sh
# Confirm the four D1 tables exist locally.
npm run db:verify:local

# Run the test suite.
npm test

# Type-check and build the Worker/UI bundle.
npm run build
```

## Deployment

The committed `wrangler.jsonc` defines the D1, Workers AI, and Workflow bindings. Set up the database once, apply its production schema, then deploy:

```sh
npx wrangler login
npx wrangler d1 create incident-investigator
```

Copy the returned database ID into the `DB` database entry in both the top-level and `env.production` sections of `wrangler.jsonc`. Then run:

```sh
npx wrangler d1 migrations apply incident-investigator --remote --env production
npm run deploy
```

`npm run deploy` builds the app and runs `wrangler deploy --env production`. Workers AI and the Workflow are bound through the configuration; no separate runtime code path is needed for deployment.

## Demo prompts

Try these in the incident console:

- `Checkout API is returning 500 errors in us-east-1. Can you investigate what changed?`
- `Payments are timing out during confirmation. Please investigate.`
- `Orders are slow for customers in Europe. Can you find the likely cause?`

The prompts do not select hidden fixtures or scenarios. They are ordinary user symptoms; the agent must choose the evidence it needs.

## Limitations and next steps

This is intentionally a focused take-home project:

- Observability data is deterministic fixture data, not live telemetry.
- LLM tool selection can vary between production runs, despite the bounded tools and guardrails.
- There is no authentication, multi-user incident access control, alert ingestion, or human escalation workflow.
- The UI polls for Workflow progress rather than streaming events.

Next improvements would be adapters for real log/metric/trace providers, evaluation cases that score diagnosis quality, auth/RBAC, streaming progress updates, human approval for remediations, and richer incident timelines.

## AI-assisted development

The assignment was developed with AI assistance for architecture exploration, implementation, debugging, and documentation. The assignment-scoped prompt transcript is in [PROMPT_HISTORY.md](./PROMPT_HISTORY.md).
