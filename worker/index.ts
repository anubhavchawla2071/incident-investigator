export interface Env {
	AI?: Ai;
	DB: D1Database;
}

export default {
	fetch(request, env): Response {
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

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
