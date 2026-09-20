import {
	runInvestigationTool,
	type GetMetricsInput,
	type GetRecentDeploymentsInput,
	type GetServiceHealthInput,
	type GetTraceInput,
	type InvestigationToolRequest,
	type InvestigationToolResult,
	allowedMetricNames,
	availableMetricsByService,
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
		finalReportRequired?: boolean;
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

type RunnableToolRequest = InvestigationToolRequest & { policyResult?: InvestigationToolResult };

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
			if (toolRuns.length >= MAX_TOOL_CALLS || hasSufficientEvidence(symptom, toolRuns)) {
				const finalDecision = await steps.do("write report from collected evidence", () =>
					model.decide({ symptom, toolRuns, finalReportRequired: true }),
				);
				const report = await steps.do("write final report", () =>
					coordinator.finalize(
						finalDecision.kind === "report" ? finalDecision.report : createLimitReport(toolRuns),
					),
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

			const request = applyInvestigationPolicy({
				symptom,
				toolRuns,
				request: parseToolRequest(decision.request),
			});
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

	async runTool(request: RunnableToolRequest, ordinal: number): Promise<StoredToolRun> {
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

		const output = request.policyResult ?? runInvestigationTool(request);
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

function applyInvestigationPolicy({
	symptom,
	toolRuns,
	request,
}: {
	symptom: string;
	toolRuns: StoredToolRun[];
	request: InvestigationToolRequest;
}): RunnableToolRequest {
	if (hasExactToolRun(toolRuns, request)) {
		return withPolicyResult(request, `Duplicate tool call rejected: ${request.tool} was already run with the same input.`);
	}

	const focus = focusedService(symptom, toolRuns);
	const recommended = focus ? nextFocusedRequest(focus, toolRuns) : null;
	if (recommended && !sameToolCall(request, recommended) && !isFocusedLogRequest(request, recommended)) {
		return recommended;
	}

	if (request.tool === "getMetrics" && !metricExists(request.input.service, request.input.region, request.input.metric)) {
		return recommended ?? withPolicyResult(
			request,
			`Metric ${request.input.metric} is not available for ${request.input.service}${request.input.region ? ` in ${request.input.region}` : ""}.`,
		);
	}

	if (request.tool === "getTrace") {
		const traceIds = observedTraceIds(toolRuns);
		if (traceIds.has(request.input.traceId)) {
			return request;
		}
		const [firstTraceId] = traceIds;
		return firstTraceId
			? { tool: "getTrace", input: { traceId: firstTraceId } }
			: withPolicyResult(request, `Trace ID ${request.input.traceId} was rejected because it has not appeared in prior tool results.`);
	}

	return request;
}

interface InvestigationFocus {
	service: string;
	region: string;
	healthText: string;
}

function focusedService(symptom: string, toolRuns: StoredToolRun[]): InvestigationFocus | null {
	const requestedRegion = mentionedRegion(symptom.toLowerCase());
	const candidates = healthEntries(toolRuns)
		.map((entry) => ({
			...entry,
			score: focusScore(symptom, entry, requestedRegion),
		}))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score);
	const candidate = candidates[0];
	return candidate ? { service: candidate.service, region: requestedRegion ?? candidate.region, healthText: candidate.healthText } : null;
}

function nextFocusedRequest(focus: InvestigationFocus, toolRuns: StoredToolRun[]): InvestigationToolRequest | null {
	const metric = relevantMetric(focus);
	if (metric && !hasMetricRun(toolRuns, focus.service, focus.region, metric)) {
		return { tool: "getMetrics", input: { service: focus.service, region: focus.region, metric } };
	}
	if (!hasToolRun(toolRuns, "searchLogs", focus.service, focus.region)) {
		return { tool: "searchLogs", input: { service: focus.service, region: focus.region, level: "error", limit: 10 } };
	}
	const traceId = firstUninspectedTraceId(focusedLogRuns(focus, toolRuns), toolRuns);
	if (traceId) {
		return { tool: "getTrace", input: { traceId } };
	}
	const implicatedService = implicatedServiceFromEvidence(focus, toolRuns) ?? focus.service;
	if (!hasToolRun(toolRuns, "getRecentDeployments", implicatedService, focus.region)) {
		return { tool: "getRecentDeployments", input: { service: implicatedService, region: focus.region, limit: 3 } };
	}

	return null;
}

function hasSufficientEvidence(symptom: string, toolRuns: StoredToolRun[]) {
	const focus = focusedService(symptom, toolRuns);
	const metric = focus && relevantMetric(focus);
	if (!focus || !metric || !hasMetricRun(toolRuns, focus.service, focus.region, metric)) return false;

	const logRuns = focusedLogRuns(focus, toolRuns);
	if (!logRuns.length) return false;
	const traceId = firstUninspectedTraceId(logRuns, []);
	if (traceId && !hasToolRun(toolRuns, "getTrace", undefined, undefined, traceId)) return false;

	const implicatedService = implicatedServiceFromEvidence(focus, toolRuns) ?? focus.service;
	return hasToolRun(toolRuns, "getRecentDeployments", implicatedService, focus.region);
}

function healthEntries(toolRuns: StoredToolRun[]) {
	const health = toolRuns.find((toolRun) => toolRun.toolName === "getServiceHealth" && isRecord(toolRun.output))?.output;
	if (!isRecord(health) || !Array.isArray(health.services)) return [];
	return health.services.flatMap((service) => {
		if (!isRecord(service) || typeof service.service !== "string" || typeof service.region !== "string") return [];
		return [{ service: service.service, region: service.region, healthText: JSON.stringify(service).toLowerCase() }];
	});
}

function focusScore(symptom: string, entry: { service: string; region: string; healthText: string }, requestedRegion: string | undefined) {
	const lowerSymptom = symptom.toLowerCase();
	const serviceTokens = entry.service.split(/[-_]/).filter((token) => token.length > 2);
	const explicitlyNamed = lowerSymptom.includes(entry.service) || serviceTokens.some((token) => lowerSymptom.includes(token));
	const symptomSignals = lowerSymptom.match(/timeout|timing out|slow|latency|error|500|5xx|database|connection|pool/g) ?? [];
	const matchedSignals = symptomSignals.filter((signal) => entry.healthText.includes(signal) || (signal === "timing out" && entry.healthText.includes("timeout")));
	return (explicitlyNamed ? 100 : 0) + matchedSignals.length * 10 + (requestedRegion === entry.region ? 5 : 0);
}

function relevantMetric(focus: InvestigationFocus) {
	const metrics = availableMetricsByService.find((entry) => entry.service === focus.service && entry.region === focus.region)?.metrics ?? [];
	if (!metrics.length) return null;
	if (/database|pool|connection/.test(focus.healthText)) return metrics.find((metric) => metric.startsWith("db.pool.")) ?? metrics[0];
	if (/error|5xx|500/.test(focus.healthText)) return metrics.find((metric) => metric.includes("error_rate")) ?? metrics[0];
	if (/timeout|latency|slow|duration/.test(focus.healthText)) return metrics.find((metric) => metric.includes("p95_duration")) ?? metrics[0];
	return metrics[0];
}

function withPolicyResult(request: InvestigationToolRequest, reason: string): RunnableToolRequest {
	return {
		...request,
		policyResult: { policy: { status: "rejected", reason } },
	};
}

function hasExactToolRun(toolRuns: StoredToolRun[], request: InvestigationToolRequest) {
	return toolRuns.some((toolRun) => sameToolCall({ tool: toolRun.toolName, input: toolRun.input } as InvestigationToolRequest, request));
}

function sameToolCall(left: InvestigationToolRequest, right: InvestigationToolRequest) {
	return left.tool === right.tool && stableJson(left.input) === stableJson(right.input);
}

function isFocusedLogRequest(request: InvestigationToolRequest, recommended: InvestigationToolRequest) {
	return (
		request.tool === "searchLogs" &&
		recommended.tool === "searchLogs" &&
		request.input.service === recommended.input.service &&
		request.input.region === recommended.input.region
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function mentionedRegion(symptom: string) {
	return symptom.match(/\b[a-z]{2}-[a-z]+-\d\b/)?.[0];
}

function metricExists(service: string, region: string | undefined, metric: string) {
	return availableMetricsByService.some(
		(entry) => entry.service === service && (!region || entry.region === region) && entry.metrics.includes(metric),
	);
}

function hasMetricRun(toolRuns: StoredToolRun[], service: string, region: string | undefined, metric: string) {
	return toolRuns.some(
		(toolRun) =>
			toolRun.toolName === "getMetrics" &&
			isRecord(toolRun.input) &&
			toolRun.input.service === service &&
			(!region || toolRun.input.region === region) &&
			toolRun.input.metric === metric &&
			metricRunHasSeries(toolRun),
	);
}

function metricRunHasSeries(toolRun: StoredToolRun) {
	return isRecord(toolRun.output) && Array.isArray(toolRun.output.series) && toolRun.output.series.length > 0;
}

function hasToolRun(toolRuns: StoredToolRun[], toolName: ToolName, service?: string, region?: string, traceId?: string) {
	return toolRuns.some(
		(toolRun) =>
			toolRun.toolName === toolName &&
			isRecord(toolRun.input) &&
			(!service || toolRun.input.service === service) &&
			(!region || toolRun.input.region === region) &&
			(!traceId || toolRun.input.traceId === traceId),
	);
}

function observedTraceIds(toolRuns: StoredToolRun[]) {
	const traceIds = new Set<string>();
	for (const toolRun of toolRuns) {
		if (toolRun.status !== "succeeded" || !toolRun.output || isPolicyResult(toolRun.output)) continue;
		const output = JSON.stringify(toolRun.output);
		for (const match of output.matchAll(/"traceId":"([^"]+)"/g)) {
			traceIds.add(match[1]);
		}
		for (const match of output.matchAll(/"id":"(trace-[^"]+)"/g)) {
			traceIds.add(match[1]);
		}
	}
	return traceIds;
}

function firstUninspectedTraceId(evidenceRuns: StoredToolRun[], toolRuns: StoredToolRun[]) {
	const inspected = new Set(
		toolRuns
			.filter((toolRun) => toolRun.toolName === "getTrace" && isRecord(toolRun.input) && typeof toolRun.input.traceId === "string")
			.map((toolRun) => (toolRun.input as GetTraceInput).traceId),
	);
	return Array.from(observedTraceIds(evidenceRuns)).find((traceId) => !inspected.has(traceId)) ?? null;
}

function focusedLogRuns(focus: InvestigationFocus, toolRuns: StoredToolRun[]) {
	return toolRuns.filter(
		(toolRun) =>
			toolRun.toolName === "searchLogs" &&
			isRecord(toolRun.input) &&
			toolRun.input.service === focus.service &&
			toolRun.input.region === focus.region &&
			toolRun.status === "succeeded" &&
			toolRun.output &&
			!isPolicyResult(toolRun.output),
	);
}

function implicatedServiceFromEvidence(focus: InvestigationFocus, toolRuns: StoredToolRun[]) {
	const upstreamFromLogs = focusedLogRuns(focus, toolRuns)
		.map((toolRun) => upstreamServiceFrom(toolRun.output))
		.find(Boolean);
	if (upstreamFromLogs) return upstreamFromLogs;

	for (const toolRun of toolRuns) {
		if (toolRun.toolName !== "getTrace" || !isRecord(toolRun.output) || !isRecord(toolRun.output.trace) || !Array.isArray(toolRun.output.trace.spans)) continue;
		const dependency = toolRun.output.trace.spans.find(
			(span) => isRecord(span) && span.service !== focus.service && span.status === "error" && typeof span.service === "string",
		);
		if (isRecord(dependency) && typeof dependency.service === "string") return dependency.service;
	}

	return null;
}

function upstreamServiceFrom(value: unknown) {
	const output = typeof value === "string" ? value : JSON.stringify(value);
	return output.match(/"upstream":"([^"]+)"/)?.[1] ?? output.match(/"service":"((?!checkout-api)[^"]+)"/)?.[1] ?? null;
}

function isPolicyResult(value: unknown) {
	return isRecord(value) && isRecord(value.policy) && value.policy.status === "rejected";
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
