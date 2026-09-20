import {
	runInvestigationTool,
	type GetMetricsInput,
	type GetRecentDeploymentsInput,
	type GetServiceHealthInput,
	type GetTraceInput,
	type InvestigationToolRequest,
	type InvestigationToolResult,
	allowedMetricNames,
	type SearchLogsInput,
	type ToolName,
} from "./tools";

export type ReportOutcome = "resolved" | "inconclusive";

export interface StoredToolRun {
	id: string;
	incidentId: string;
	toolName: ToolName;
	input: InvestigationToolRequest["input"];
	output: InvestigationToolResult | null;
	status: "running" | "succeeded" | "failed";
}

export interface InvestigationReportDraft {
	outcome: ReportOutcome;
	diagnosis: string;
	rootCause: string;
	confidence: number;
	suggestedNextSteps: string[];
	evidenceToolRunIds: string[];
}

export interface InvestigationReport extends InvestigationReportDraft {
	id: string;
	incidentId: string;
}

export type ModelDecision =
	| { kind: "tool"; request: unknown }
	| { kind: "report"; report: InvestigationReportDraft };

export interface InvestigationModel {
	decide(input: {
		symptom: string;
		toolRuns: StoredToolRun[];
	}): Promise<ModelDecision>;
}

export interface InvestigationStore {
	getUserMessage(incidentId: string): Promise<string | null>;
	setActivity(incidentId: string, activity: string): Promise<void>;
	markFailed(incidentId: string, message: string): Promise<void>;
	getToolRun(toolRunId: string): Promise<StoredToolRun | null>;
	createToolRun(toolRun: Omit<StoredToolRun, "status" | "output">): Promise<StoredToolRun>;
	completeToolRun(toolRunId: string, output: InvestigationToolResult): Promise<StoredToolRun>;
	listToolRuns(incidentId: string): Promise<StoredToolRun[]>;
	saveReport(report: InvestigationReport): Promise<void>;
	markComplete(incidentId: string, outcome: ReportOutcome): Promise<void>;
}

export interface InvestigationSteps {
	do<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

export interface InvestigationResult {
	status: "resolved" | "inconclusive" | "failed";
	report?: InvestigationReport;
	error?: string;
}

const MAX_TOOL_CALLS = 6;

export async function runInvestigation({
	incidentId,
	model,
	store,
	steps,
}: {
	incidentId: string;
	model: InvestigationModel;
	store: InvestigationStore;
	steps: InvestigationSteps;
}): Promise<InvestigationResult> {
	try {
		const symptom = await steps.do("load incident message", async () => {
			const message = await store.getUserMessage(incidentId);
			if (!message) {
				throw new Error("Incident does not have a user message.");
			}
			return message;
		});

		const coordinator = new InvestigationCoordinator(incidentId, store);
		await steps.do("check service health", () =>
			coordinator.runTool({ tool: "getServiceHealth", input: {} }, 0),
		);

		while (true) {
			const toolRuns = await store.listToolRuns(incidentId);
			if (toolRuns.length >= MAX_TOOL_CALLS) {
				const report = await steps.do("write inconclusive report", () =>
					coordinator.finalize(createLimitReport(toolRuns)),
				);
				return { status: report.outcome, report };
			}

			const decision = await steps.do(`choose next action ${toolRuns.length}`, () =>
				model.decide({ symptom, toolRuns }),
			);

			if (decision.kind === "report") {
				const report = await steps.do("write final report", () => coordinator.finalize(decision.report));
				return { status: report.outcome, report };
			}

			const request = parseToolRequest(decision.request);
			await steps.do(`run ${request.tool} ${toolRuns.length + 1}`, () =>
				coordinator.runTool(request, toolRuns.length),
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "Investigation failed unexpectedly.";
		await steps.do("mark investigation failed", async () => {
			await store.markFailed(incidentId, message);
		});
		return { status: "failed", error: message };
	}
}

export class EvidenceValidationError extends Error {}

class InvestigationCoordinator {
	constructor(
		private readonly incidentId: string,
		private readonly store: InvestigationStore,
	) {}

	async runTool(request: InvestigationToolRequest, ordinal: number): Promise<StoredToolRun> {
		const toolRunId = `${this.incidentId}:tool:${ordinal + 1}`;
		await this.store.setActivity(this.incidentId, activityForTool(request.tool));

		const existing = await this.store.getToolRun(toolRunId);
		if (existing?.status === "succeeded") {
			return existing;
		}

		const toolRun =
			existing ??
			(await this.store.createToolRun({
				id: toolRunId,
				incidentId: this.incidentId,
				toolName: request.tool,
				input: request.input,
			}));

		if (toolRun.status === "succeeded") {
			return toolRun;
		}

		const output = runInvestigationTool(request);
		return this.store.completeToolRun(toolRunId, output);
	}

	async finalize(draft: InvestigationReportDraft): Promise<InvestigationReport> {
		validateReportDraft(draft);
		const toolRuns = await this.store.listToolRuns(this.incidentId);
		const successfulRunIds = new Set(
			toolRuns.filter((toolRun) => toolRun.status === "succeeded").map((toolRun) => toolRun.id),
		);

		for (const evidenceId of draft.evidenceToolRunIds) {
			if (!successfulRunIds.has(evidenceId)) {
				throw new EvidenceValidationError(
					`Report cites tool run ${evidenceId}, which does not belong to this incident.`,
				);
			}
		}

		const report: InvestigationReport = {
			...draft,
			id: `${this.incidentId}:report`,
			incidentId: this.incidentId,
		};
		await this.store.setActivity(this.incidentId, "Writing investigation report");
		await this.store.saveReport(report);
		await this.store.markComplete(this.incidentId, report.outcome);
		return report;
	}
}

function createLimitReport(toolRuns: StoredToolRun[]): InvestigationReportDraft {
	return {
		outcome: "inconclusive",
		diagnosis: "The investigation reached its tool-call limit before finding a supported diagnosis.",
		rootCause: "Inconclusive after the bounded investigation.",
		confidence: 0.2,
		suggestedNextSteps: ["Review the collected evidence and continue with a fresh investigation."],
		evidenceToolRunIds: toolRuns.map((toolRun) => toolRun.id),
	};
}

function validateReportDraft(draft: InvestigationReportDraft) {
	if (
		!draft.diagnosis.trim() ||
		!draft.rootCause.trim() ||
		!Number.isFinite(draft.confidence) ||
		draft.confidence < 0 ||
		draft.confidence > 1 ||
		!Array.isArray(draft.suggestedNextSteps) ||
		!draft.suggestedNextSteps.every((step) => typeof step === "string" && Boolean(step.trim())) ||
		!Array.isArray(draft.evidenceToolRunIds) ||
		!draft.evidenceToolRunIds.length ||
		new Set(draft.evidenceToolRunIds).size !== draft.evidenceToolRunIds.length
	) {
		throw new EvidenceValidationError("Final report has an invalid structure or evidence list.");
	}
}

function parseToolRequest(value: unknown): InvestigationToolRequest {
	if (!isRecord(value) || typeof value.tool !== "string") {
		throw new Error("Model returned an invalid tool call.");
	}

	const input = normalizeToolInput(value.tool, value.input ?? {});

	switch (value.tool) {
		case "searchLogs":
			if (optionalStrings(input, ["service", "region", "query", "level", "start", "end"]) && optionalNumber(input, "limit") && optionalLogLevel(input, "level")) {
				return { tool: value.tool, input: input as SearchLogsInput };
			}
			break;
		case "getMetrics":
			if (typeof input.service === "string" && typeof input.metric === "string" && optionalStrings(input, ["region"])) {
				return { tool: value.tool, input: input as unknown as GetMetricsInput };
			}
			break;
		case "getServiceHealth":
			if (optionalStrings(input, ["service", "region"])) {
				return { tool: value.tool, input: input as GetServiceHealthInput };
			}
			break;
		case "getRecentDeployments":
			if (optionalStrings(input, ["service", "region"]) && optionalNumber(input, "limit")) {
				return { tool: value.tool, input: input as GetRecentDeploymentsInput };
			}
			break;
		case "getTrace":
			if (typeof input.traceId === "string") {
				return { tool: value.tool, input: input as unknown as GetTraceInput };
			}
			break;
	}

	throw new Error(`Model returned invalid input for ${value.tool}.`);
}

function normalizeToolInput(tool: string, rawInput: unknown): Record<string, unknown> {
	const input = parseInputObject(rawInput);
	switch (tool) {
		case "searchLogs":
			return normalizeSearchLogsInput(input);
		case "getMetrics":
			return normalizeGetMetricsInput(input);
		case "getRecentDeployments":
			return normalizeLimit(input);
		default:
			return input;
	}
}

function normalizeSearchLogsInput(input: Record<string, unknown>) {
	const normalized = normalizeLimit(input);
	const level = normalizeLogLevel(normalized.level ?? normalized.severity);
	if (level) {
		normalized.level = level;
	}
	delete normalized.severity;
	return normalized;
}

function normalizeGetMetricsInput(input: Record<string, unknown>) {
	return {
		...input,
		metric: typeof input.metric === "string" ? normalizeMetricName(input.metric) : input.metric,
	};
}

function normalizeLimit(input: Record<string, unknown>) {
	const normalized = { ...input };
	if (typeof normalized.limit === "string" && /^\d+$/.test(normalized.limit.trim())) {
		normalized.limit = Number(normalized.limit.trim());
	}
	return normalized;
}

function normalizeMetricName(metric: string) {
	const cleaned = metric.trim().toLowerCase();
	const compact = cleaned.replace(/[\s._]+/g, "-");
	const metricAliases: Record<string, (typeof allowedMetricNames)[number]> = {
		"http-server-error-rate": "http.server.error_rate",
		"error-rate": "http.server.error_rate",
		"errorrate": "http.server.error_rate",
		"5xx-rate": "http.server.error_rate",
		"500-rate": "http.server.error_rate",
		"http-server-p95-duration": "http.server.p95_duration",
		"p95-duration": "http.server.p95_duration",
		"p95-latency": "http.server.p95_duration",
		"latency-p95": "http.server.p95_duration",
		"duration-p95": "http.server.p95_duration",
		"db-pool-active-connections": "db.pool.active_connections",
		"db-pool-active-connection": "db.pool.active_connections",
		"db-connections": "db.pool.active_connections",
		"database-connections": "db.pool.active_connections",
		"active-connections": "db.pool.active_connections",
		"connection-pool": "db.pool.active_connections",
	};
	return metricAliases[compact] ?? metric;
}

function normalizeLogLevel(level: unknown) {
	if (typeof level !== "string") return null;
	const normalized = level.trim().toLowerCase();
	return isLogLevel(normalized) ? normalized : null;
}

function parseInputObject(value: unknown) {
	if (isRecord(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed)) return parsed;
		} catch {
			return {};
		}
	}
	return {};
}

function activityForTool(tool: ToolName) {
	return {
		searchLogs: "Searching logs",
		getMetrics: "Reviewing metrics",
		getServiceHealth: "Checking service health",
		getRecentDeployments: "Reviewing recent deployments",
		getTrace: "Inspecting a trace",
	}[tool];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalStrings(input: Record<string, unknown>, names: string[]) {
	return names.every((name) => input[name] === undefined || typeof input[name] === "string");
}

function optionalNumber(input: Record<string, unknown>, name: string) {
	return input[name] === undefined || (typeof input[name] === "number" && Number.isFinite(input[name]));
}

function optionalLogLevel(input: Record<string, unknown>, name: string) {
	return input[name] === undefined || (typeof input[name] === "string" && isLogLevel(input[name]));
}

function isLogLevel(value: string): value is NonNullable<SearchLogsInput["level"]> {
	return value === "debug" || value === "info" || value === "warn" || value === "error";
}
