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

	it("stops at six tool calls and records an inconclusive report", async () => {
		const store = new MemoryInvestigationStore("limit-incident", "The API is returning 500 errors.");
		const model: InvestigationModel = {
			decide: async () => ({ kind: "tool", request: { tool: "searchLogs", input: {} } }),
		};

		const result = await runInvestigation({
			incidentId: "limit-incident",
			model,
			store,
			steps: directSteps,
		});

		expect(result.status).toBe("inconclusive");
		expect(store.toolRuns).toHaveLength(6);
		expect(store.report?.outcome).toBe("inconclusive");
		expect(store.report?.evidenceToolRunIds).toEqual(store.toolRuns.map((toolRun) => toolRun.id));
	});
});

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
