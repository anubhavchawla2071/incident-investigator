import { describe, expect, it, vi } from "vitest";

import { FixtureInvestigationModel } from "./fixture-investigation-model";
import type { StoredToolRun } from "./investigation";
import {
	createInvestigationModel,
	INVESTIGATION_MODEL,
	WorkersAiInvestigationModel,
	type WorkersAiBinding,
} from "./workers-ai-investigation-model";

const healthRun: StoredToolRun = {
	id: "incident-1:tool:1",
	incidentId: "incident-1",
	toolName: "getServiceHealth",
	input: {},
	output: { services: [{ service: "checkout-api", region: "us-east-1", status: "degraded", observedAt: "2026-09-20T10:15:00Z", checks: [] }] },
	status: "succeeded",
};

describe("investigation model selection", () => {
	it("keeps the deterministic fixture model when no Workers AI binding exists", () => {
		expect(createInvestigationModel()).toBeInstanceOf(FixtureInvestigationModel);
	});

	it("uses Llama function-calling output when a Workers AI binding exists", async () => {
		const run = vi.fn().mockResolvedValue({
			tool_calls: [{ name: "getMetrics", arguments: { service: "checkout-api", region: "us-east-1", metric: "http.server.error_rate" } }],
		});
		const model = createInvestigationModel({ run } as WorkersAiBinding);

		const decision = await model.decide({ symptom: "The API is returning 500 errors.", toolRuns: [healthRun] });

		expect(model).toBeInstanceOf(WorkersAiInvestigationModel);
		expect(decision).toEqual({
			kind: "tool",
			request: { tool: "getMetrics", input: { service: "checkout-api", region: "us-east-1", metric: "http.server.error_rate" } },
		});
		expect(run).toHaveBeenCalledWith(INVESTIGATION_MODEL, expect.objectContaining({
			tools: expect.arrayContaining([expect.objectContaining({ name: "getServiceHealth" })]),
		}));

		const prompt = (run.mock.calls[0][1] as { messages: Array<{ content: string }> }).messages[1].content;
		expect(prompt).toContain("serviceCatalog");
		expect(prompt).toContain("degradedServiceHealth");
		expect(prompt).toContain("availableMetrics");
		expect(prompt).toContain("availableMetricsByService");
		expect(prompt).toContain("http.server.error_rate");
		expect(prompt).toContain("completedToolResults");
		expect(prompt).toContain("checkout-api");
		expect(prompt).not.toContain("missing customerTier");
	});

	it("converts a structured Workers AI response into a final report", async () => {
		const model = createInvestigationModel({
			run: async () => ({
				response: JSON.stringify({
					outcome: "inconclusive",
					diagnosis: "Evidence is incomplete.",
					rootCause: "Inconclusive.",
					confidence: 0.2,
					suggestedNextSteps: ["Inspect another time window."],
					evidenceToolRunIds: ["incident-1:tool:1"],
				}),
			}),
		} as WorkersAiBinding);

		await expect(model.decide({ symptom: "Something is wrong.", toolRuns: [healthRun] })).resolves.toMatchObject({
			kind: "report",
			report: { outcome: "inconclusive", evidenceToolRunIds: ["incident-1:tool:1"] },
		});
	});

	it("uses compact evidence and retries one malformed final report", async () => {
		const run = vi
			.fn()
			.mockResolvedValueOnce({ response: "not valid JSON" })
			.mockResolvedValueOnce({
				response: JSON.stringify({
					outcome: "resolved",
					diagnosis: "Checkout failures originate in cart reservation validation.",
					rootCause: "cart-service 2.14.0 tightened promotion validation.",
					confidence: 0.94,
					suggestedNextSteps: ["Roll back or patch cart-service 2.14.0."],
					evidenceToolRunIds: finalEvidenceRuns.map((toolRun) => toolRun.id),
				}),
			});
		const model = createInvestigationModel({ run } as WorkersAiBinding);

		await expect(
			model.decide({ symptom: "Checkout API is returning 500 errors.", toolRuns: finalEvidenceRuns, finalReportRequired: true }),
		).resolves.toMatchObject({ kind: "report", report: { outcome: "resolved" } });

		expect(run).toHaveBeenCalledTimes(2);
		const firstRequest = run.mock.calls[0][1] as { tools?: unknown; messages: Array<{ content: string }> };
		expect(firstRequest.tools).toBeUndefined();
		expect(firstRequest.messages[1].content).toContain("checkout-api us-east-1 http.server.error_rate increased from 0.2% to 7.4%.");
		expect(firstRequest.messages[1].content).toContain("trace-checkout-500-01");
		expect(firstRequest.messages[1].content).toContain("promotion_validation");
		expect(firstRequest.messages[1].content).not.toContain("serviceCatalog");
		expect(firstRequest.messages[1].content).not.toContain("completedToolResults");
		expect((run.mock.calls[1][1] as { messages: Array<{ content: string }> }).messages[1].content).toContain(
			"Previous response was not valid JSON",
		);
	});
});

const finalEvidenceRuns: StoredToolRun[] = [
	healthRun,
	{
		id: "incident-1:tool:2",
		incidentId: "incident-1",
		toolName: "getMetrics",
		input: { service: "checkout-api", region: "us-east-1", metric: "http.server.error_rate" },
		output: {
			series: [{ service: "checkout-api", region: "us-east-1", name: "http.server.error_rate", unit: "percent", points: [{ timestamp: "2026-09-20T09:55:00Z", value: 0.2 }, { timestamp: "2026-09-20T10:15:00Z", value: 7.4 }] }],
		},
		status: "succeeded",
	},
	{
		id: "incident-1:tool:3",
		incidentId: "incident-1",
		toolName: "searchLogs",
		input: { service: "checkout-api", region: "us-east-1", level: "error", query: "500" },
		output: {
			logs: [{ id: "log-checkout-001", timestamp: "2026-09-20T10:07:12Z", service: "checkout-api", region: "us-east-1", level: "error", message: "cart reservation request failed", attributes: { statusCode: 500, upstream: "cart-service", traceId: "trace-checkout-500-01" } }],
			returned: 1,
		},
		status: "succeeded",
	},
	{
		id: "incident-1:tool:4",
		incidentId: "incident-1",
		toolName: "getTrace",
		input: { traceId: "trace-checkout-500-01" },
		output: {
			trace: { id: "trace-checkout-500-01", region: "us-east-1", rootService: "checkout-api", startedAt: "2026-09-20T10:08:03Z", durationMs: 184, status: "error", spans: [{ spanId: "span-2", parentSpanId: "span-1", service: "cart-service", operation: "POST /reservations", durationMs: 123, status: "error", attributes: { errorType: "promotion_validation" } }] },
		},
		status: "succeeded",
	},
	{
		id: "incident-1:tool:5",
		incidentId: "incident-1",
		toolName: "getRecentDeployments",
		input: { service: "cart-service", region: "us-east-1" },
		output: {
			deployments: [{ id: "dep-cart-2140", service: "cart-service", version: "2.14.0", region: "us-east-1", completedAt: "2026-09-20T10:01:00Z", status: "succeeded", summary: "Enable promotion request contract v2.", changes: ["Tighten promotion request validation."] }],
			returned: 1,
		},
		status: "succeeded",
	},
];
