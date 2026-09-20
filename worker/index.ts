import { D1InvestigationStore } from "./investigation-store";

export interface Env {
	AI?: Ai;
	DB: D1Database;
	INVESTIGATION_WORKFLOW: Workflow<{ incidentId: string }>;
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/health") {
			return Response.json({
				status: "ok",
				bindings: {
					d1: Boolean(env.DB),
				workersAi: Boolean(env.AI),
				},
			});
		}

		if (url.pathname === "/api/incidents" && request.method === "POST") {
			const message = await readIncidentMessage(request);
			if (!message) {
				return Response.json({ error: "message must be a non-empty string." }, { status: 400 });
			}

			const incidentId = crypto.randomUUID();
			const messageId = crypto.randomUUID();
			await env.DB.batch([
				env.DB
					.prepare(
						"INSERT INTO incidents (id, title, status, current_activity) VALUES (?, ?, 'investigating', 'Starting investigation')",
					)
					.bind(incidentId, incidentTitle(message)),
				env.DB
					.prepare("INSERT INTO messages (id, incident_id, role, content) VALUES (?, ?, 'user', ?)")
					.bind(messageId, incidentId, message),
			]);

			try {
				const workflow = await env.INVESTIGATION_WORKFLOW.create({
					id: incidentId,
					params: { incidentId },
				});
				return Response.json({ incidentId, workflowId: workflow.id, status: "investigating" }, { status: 202 });
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unable to start investigation workflow.";
				await env.DB
					.prepare("UPDATE incidents SET status = 'failed', current_activity = ?, updated_at = datetime('now') WHERE id = ?")
					.bind(`Unable to start workflow: ${errorMessage}`, incidentId)
					.run();
				return Response.json({ error: "Unable to start investigation workflow." }, { status: 500 });
			}
		}

		const incidentId = incidentIdFromPath(url.pathname);
		if (incidentId && request.method === "GET") {
			const details = await new D1InvestigationStore(env.DB).getIncidentDetails(incidentId);
			return details
				? Response.json(details)
				: Response.json({ error: "Incident not found." }, { status: 404 });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

export { IncidentInvestigationWorkflow } from "./investigation-workflow";

async function readIncidentMessage(request: Request): Promise<string | null> {
	try {
		const body = (await request.json()) as { message?: unknown };
		if (typeof body.message !== "string") {
			return null;
		}
		const message = body.message.trim();
		return message && message.length <= 2_000 ? message : null;
	} catch {
		return null;
	}
}

function incidentTitle(message: string) {
	return message.length <= 120 ? message : `${message.slice(0, 117)}...`;
}

function incidentIdFromPath(pathname: string) {
	const match = pathname.match(/^\/api\/incidents\/([^/]+)$/);
	return match?.[1] ? decodeURIComponent(match[1]) : null;
}
