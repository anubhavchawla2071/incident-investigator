import { describe, expect, it } from "vitest";

import { FixtureInvestigationModel } from "./fixture-investigation-model";
import {
	runInvestigation,
	type InvestigationModel,
	type InvestigationReport,
	type InvestigationStore,
	type InvestigationSteps,
	type StoredToolRun,
} from "./investigation";
import type { InvestigationToolRequest, InvestigationToolResult, ToolName } from "./tools";
import { expectedDiagnoses } from "./test-support/expected-diagnoses";

const directSteps: InvestigationSteps = {
	do: (_name, operation) => operation(),
};

describe("investigation coordinator", () => {
	it("starts with service health and persists a supported checkout diagnosis", async () => {
		const store = new MemoryInvestigationStore("checkout-incident", "The API is returning 500 errors. Can you investigate?");

		const result = await runInvestigation({
			incidentId: "checkout-incident",
			model: new FixtureInvestigationModel(),
			store,
			steps: directSteps,
		});

		expect(result.status).toBe("resolved");
		expect(store.toolRuns).toHaveLength(5);
		expect(store.toolRuns[0]).toMatchObject({ toolName: "getServiceHealth", input: {} });
		expect(result.report?.rootCause).toBe(expectedDiagnoses.checkout);
		expect(store.report?.evidenceToolRunIds).toEqual(store.toolRuns.map((toolRun) => toolRun.id));
		expect(store.incident.status).toBe("resolved");
	});

	it("writes an inconclusive report when the symptom does not identify a degraded service", async () => {
		const store = new MemoryInvestigationStore("unknown-incident", "Customers say the site feels unusual.");

		const result = await runInvestigation({
			incidentId: "unknown-incident",
			model: new FixtureInvestigationModel(),
			store,
			steps: directSteps,
		});

		expect(result.status).toBe("inconclusive");
		expect(store.toolRuns).toHaveLength(1);
		expect(store.toolRuns[0].toolName).toBe("getServiceHealth");
		expect(store.report?.outcome).toBe("inconclusive");
	});

	it("rejects a report that cites a tool run from another incident", async () => {
		const store = new MemoryInvestigationStore("evidence-incident", "The API is returning 500 errors.");
		const model: InvestigationModel = {
			decide: async () => ({
				kind: "report",
				report: {
					outcome: "resolved",
					diagnosis: "An unsupported diagnosis.",
					rootCause: "An unsupported root cause.",
					confidence: 0.9,
					suggestedNextSteps: ["Do not use cross-incident evidence."],
					evidenceToolRunIds: ["another-incident:tool:1"],
				},
			}),
		};

		const result = await runInvestigation({
			incidentId: "evidence-incident",
			model,
			store,
			steps: directSteps,
		});

		expect(result).toMatchObject({ status: "failed" });
		expect(result.error).toContain("does not belong to this incident");
		expect(store.report).toBeUndefined();
		expect(store.incident.status).toBe("failed");
	});

	it("stops at six tool calls and asks the model for a final report", async () => {
		const store = new MemoryInvestigationStore("limit-incident", "Customers report an unspecified issue.");
		let finalReportRequested = false;
		const followUpRequests = [
			{ tool: "searchLogs", input: {} },
			{ tool: "searchLogs", input: { query: "timeout" } },
			{ tool: "getRecentDeployments", input: {} },
			{ tool: "getServiceHealth", input: { service: "checkout-api" } },
			{ tool: "getMetrics", input: { service: "checkout-api", region: "us-east-1", metric: "http.server.error_rate" } },
		] as const;
		const model: InvestigationModel = {
			decide: async ({ finalReportRequired }) => {
				if (finalReportRequired) {
					finalReportRequested = true;
					return {
						kind: "report",
						report: {
							outcome: "inconclusive",
							diagnosis: "The available evidence does not support a conclusive diagnosis.",
							rootCause: "Inconclusive after reviewing the collected evidence.",
							confidence: 0.3,
							suggestedNextSteps: ["Continue from the collected evidence."],
							evidenceToolRunIds: store.toolRuns.map((toolRun) => toolRun.id),
						},
					};
				}
				return { kind: "tool", request: followUpRequests[store.toolRuns.length - 1] };
			},
		};

		const result = await runInvestigation({
			incidentId: "limit-incident",
			model,
			store,
			steps: directSteps,
		});

		expect(result.status).toBe("inconclusive");
		expect(store.toolRuns).toHaveLength(6);
		expect(finalReportRequested).toBe(true);
		expect(store.report?.outcome).toBe("inconclusive");
		expect(store.report?.evidenceToolRunIds).toEqual(store.toolRuns.map((toolRun) => toolRun.id));
	});

	it("normalizes common Llama-style tool inputs before validation", async () => {
		const store = new MemoryInvestigationStore("llama-incident", "The API is returning 500 errors.");
		let calls = 0;
		const model: InvestigationModel = {
			decide: async () => {
				calls += 1;
				if (calls === 1) {
					return {
						kind: "tool",
						request: {
							tool: "getMetrics",
							input: { service: "checkout-api", region: "us-east-1", metric: "error-rate" },
						},
					};
				}
				if (calls === 2) {
					return {
						kind: "tool",
						request: {
							tool: "searchLogs",
							input: { service: "checkout-api", region: "us-east-1", severity: "ERROR", limit: "2" },
						},
					};
				}
				return {
					kind: "report",
					report: {
						outcome: "inconclusive",
						diagnosis: "The model gathered normalized metric and log evidence.",
						rootCause: "More evidence is needed.",
						confidence: 0.3,
						suggestedNextSteps: ["Continue with traces and deployments."],
						evidenceToolRunIds: store.toolRuns.map((toolRun) => toolRun.id),
					},
				};
			},
		};

		const result = await runInvestigation({
			incidentId: "llama-incident",
			model,
			store,
			steps: directSteps,
		});

		expect(result.status).toBe("inconclusive");
		expect(store.toolRuns[1]).toMatchObject({
			toolName: "getMetrics",
			input: { service: "checkout-api", region: "us-east-1", metric: "http.server.error_rate" },
		});
		expect(store.toolRuns[1].output).toMatchObject({ series: expect.arrayContaining([expect.objectContaining({ name: "http.server.error_rate" })]) });
		expect(store.toolRuns[2]).toMatchObject({
			toolName: "searchLogs",
			input: { service: "checkout-api", region: "us-east-1", level: "error", limit: 2 },
		});
		expect(store.toolRuns[2].output).toMatchObject({ returned: 1 });
	});

	it("rejects an unrelated service jump without choosing the next tool for the model", async () => {
		const store = new MemoryInvestigationStore("payments-incident", "Payments are timing out during confirmation.");
		let calls = 0;
		const model: InvestigationModel = {
			decide: async () => {
				calls += 1;
				if (calls === 1) return { kind: "tool", request: { tool: "getMetrics", input: { service: "checkout-api", region: "us-east-1", metric: "http.server.error_rate" } } };
				if (calls === 2) return { kind: "tool", request: { tool: "getMetrics", input: { service: "payments-service", region: "us-east-1", metric: "db.pool.active_connections" } } };
				return {
					kind: "report",
					report: {
						outcome: "inconclusive",
						diagnosis: "Payments database pressure is elevated, but more valid evidence is needed.",
						rootCause: "Inconclusive.",
						confidence: 0.4,
						suggestedNextSteps: ["Inspect payments logs or traces."],
						evidenceToolRunIds: usableToolRunIds(store.toolRuns),
					},
				};
			},
		};

		const result = await runInvestigation({
			incidentId: "payments-incident",
			model,
			store,
			steps: directSteps,
		});

		expect(result.status).toBe("inconclusive");
		expect(store.toolRuns[1]).toMatchObject({
			toolName: "getMetrics",
			input: { service: "checkout-api", metric: "http.server.error_rate" },
			output: { policy: expect.objectContaining({ status: "rejected", reason: expect.stringContaining("payments-service") }) },
		});
		expect(store.toolRuns[2]).toMatchObject({
			toolName: "getMetrics",
			input: { service: "payments-service", metric: "db.pool.active_connections" },
			output: { series: expect.any(Array) },
		});
	});

	it("records a controlled policy result when Llama invents a trace id before any trace id is observed", async () => {
		const store = new MemoryInvestigationStore("invented-trace-incident", "Something is odd in production.");
		let calls = 0;
		const model: InvestigationModel = {
			decide: async () => {
				calls += 1;
				if (calls === 1) {
					return { kind: "tool", request: { tool: "getTrace", input: { traceId: "made-up-trace" } } };
				}
				return {
					kind: "report",
					report: {
						outcome: "inconclusive",
						diagnosis: "No valid trace was available to support a diagnosis.",
						rootCause: "Inconclusive.",
						confidence: 0.2,
						suggestedNextSteps: ["Search logs first to find a real trace ID."],
						evidenceToolRunIds: usableToolRunIds(store.toolRuns),
					},
				};
			},
		};

		const result = await runInvestigation({
			incidentId: "invented-trace-incident",
			model,
			store,
			steps: directSteps,
		});

		expect(result.status).toBe("inconclusive");
		expect(store.toolRuns[1]).toMatchObject({
			toolName: "getTrace",
			input: { traceId: "made-up-trace" },
			output: { policy: expect.objectContaining({ status: "rejected" }) },
		});
		expect(store.toolRuns[1].output).not.toEqual({ trace: null });
	});

	it("records a controlled policy result for exact duplicate tool calls", async () => {
		const store = new MemoryInvestigationStore("duplicate-incident", "Something is odd in production.");
		let calls = 0;
		const model: InvestigationModel = {
			decide: async () => {
				calls += 1;
				if (calls === 1) {
					return { kind: "tool", request: { tool: "getServiceHealth", input: {} } };
				}
				return {
					kind: "report",
					report: {
						outcome: "inconclusive",
						diagnosis: "Duplicate tool call was rejected.",
						rootCause: "Inconclusive.",
						confidence: 0.2,
						suggestedNextSteps: ["Use the existing service health result."],
						evidenceToolRunIds: usableToolRunIds(store.toolRuns),
					},
				};
			},
		};

		const result = await runInvestigation({
			incidentId: "duplicate-incident",
			model,
			store,
			steps: directSteps,
		});

		expect(result.status).toBe("inconclusive");
		expect(store.toolRuns).toHaveLength(2);
		expect(store.toolRuns[1]).toMatchObject({
			toolName: "getServiceHealth",
			input: {},
			output: { policy: expect.objectContaining({ status: "rejected", reason: expect.stringContaining("Duplicate") }) },
		});
	});

	it("ends after repeated policy rejections without treating them as report evidence", async () => {
		const store = new MemoryInvestigationStore("rejected-calls-incident", "Something is odd in production.");
		let calls = 0;
		const model: InvestigationModel = {
			decide: async () => {
				calls += 1;
				if (calls <= 2) {
					return { kind: "tool", request: { tool: "getTrace", input: { traceId: "made-up-trace" } } };
				}
				throw new Error("The investigation should stop after repeated rejected calls.");
			},
		};

		const result = await runInvestigation({
			incidentId: "rejected-calls-incident",
			model,
			store,
			steps: directSteps,
		});

		expect(result.status).toBe("inconclusive");
		expect(calls).toBe(2);
		expect(store.toolRuns).toHaveLength(3);
		expect(store.report?.evidenceToolRunIds).toEqual(["rejected-calls-incident:tool:1"]);
	});
});

function usableToolRunIds(toolRuns: StoredToolRun[]) {
	return toolRuns
		.filter((toolRun) => !toolRun.output || !("policy" in toolRun.output))
		.map((toolRun) => toolRun.id);
}

class MemoryInvestigationStore implements InvestigationStore {
	readonly toolRuns: StoredToolRun[] = [];
	readonly incident = { status: "investigating", activity: "Starting investigation" };
	report: InvestigationReport | undefined;

	constructor(
		private readonly incidentId: string,
		private readonly userMessage: string,
	) {}

	async getUserMessage(incidentId: string) {
		return incidentId === this.incidentId ? this.userMessage : null;
	}

	async setActivity(_incidentId: string, activity: string) {
		this.incident.activity = activity;
	}

	async markFailed(_incidentId: string, message: string) {
		this.incident.status = "failed";
		this.incident.activity = `Investigation failed: ${message}`;
	}

	async getToolRun(toolRunId: string) {
		return this.toolRuns.find((toolRun) => toolRun.id === toolRunId) ?? null;
	}

	async createToolRun(toolRun: {
		id: string;
		incidentId: string;
		toolName: ToolName;
		input: InvestigationToolRequest["input"];
	}) {
		const stored: StoredToolRun = { ...toolRun, status: "running", output: null };
		this.toolRuns.push(stored);
		return stored;
	}

	async completeToolRun(toolRunId: string, output: InvestigationToolResult) {
		const toolRun = this.toolRuns.find((candidate) => candidate.id === toolRunId);
		if (!toolRun) {
			throw new Error(`Missing tool run ${toolRunId}`);
		}
		toolRun.output = output;
		toolRun.status = "succeeded";
		return toolRun;
	}

	async listToolRuns(incidentId: string) {
		return this.toolRuns.filter((toolRun) => toolRun.incidentId === incidentId);
	}

	async saveReport(report: InvestigationReport) {
		this.report = report;
	}

	async markComplete(_incidentId: string, outcome: "resolved" | "inconclusive") {
		this.incident.status = "resolved";
		this.incident.activity = outcome === "resolved" ? "Investigation complete" : "Investigation complete: inconclusive";
	}
}
