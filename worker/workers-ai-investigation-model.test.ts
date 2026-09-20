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
		expect(prompt).toContain("availableMetrics");
		expect(prompt).toContain("availableMetricsByService");
		expect(prompt).toContain("http.server.error_rate");
		expect(prompt).toContain("completedToolResults");
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
});
