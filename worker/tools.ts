import { simulatedProductionEnvironment } from "./fixtures";
import type {
	Deployment,
	LogEntry,
	MetricSeries,
	SimulatedProductionEnvironment,
	ServiceHealth,
	Trace,
} from "./fixtures/types";

export type ToolName =
	| "searchLogs"
	| "getMetrics"
	| "getServiceHealth"
	| "getRecentDeployments"
	| "getTrace";

export interface SearchLogsInput {
	service?: string;
	region?: string;
	query?: string;
	level?: LogEntry["level"];
	start?: string;
	end?: string;
	limit?: number;
}

export interface GetMetricsInput {
	service: string;
	metric: string;
	region?: string;
}

export interface GetServiceHealthInput {
	service?: string;
	region?: string;
}

export interface GetRecentDeploymentsInput {
	service?: string;
	region?: string;
	limit?: number;
}

export interface GetTraceInput {
	traceId: string;
}

export type InvestigationToolRequest =
 	| { tool: "searchLogs"; input: SearchLogsInput }
	| { tool: "getMetrics"; input: GetMetricsInput }
	| { tool: "getServiceHealth"; input: GetServiceHealthInput }
	| { tool: "getRecentDeployments"; input: GetRecentDeploymentsInput }
	| { tool: "getTrace"; input: GetTraceInput };

export interface SearchLogsResult {
	logs: LogEntry[];
	returned: number;
}

export interface GetMetricsResult {
	series: MetricSeries[];
}

export interface GetServiceHealthResult {
	services: ServiceHealth[];
}

export interface GetRecentDeploymentsResult {
	deployments: Deployment[];
	returned: number;
}

export interface GetTraceResult {
	trace: Trace | null;
}

export interface ToolPolicyResult {
	policy: {
		status: "rejected";
		reason: string;
	};
}

export type InvestigationToolResult =
	| SearchLogsResult
	| GetMetricsResult
	| GetServiceHealthResult
	| GetRecentDeploymentsResult
	| GetTraceResult
	| ToolPolicyResult;

export const investigationTools: Array<{ name: ToolName; description: string }> = [
	{ name: "searchLogs", description: "Search logs in the simulated production environment." },
	{ name: "getMetrics", description: "Get a metric series for one service and optional region." },
	{ name: "getServiceHealth", description: "Read a degraded-service overview or filter health checks." },
	{ name: "getRecentDeployments", description: "List recent deployments across the environment." },
	{ name: "getTrace", description: "Fetch one distributed trace by ID." },
];

export const allowedMetricNames = [
	"http.server.error_rate",
	"http.server.p95_duration",
	"db.pool.active_connections",
] as const;

export const availableMetricsByService = metricCatalog();

export function runInvestigationTool(
	request: Extract<InvestigationToolRequest, { tool: "searchLogs" }>,
): SearchLogsResult;
export function runInvestigationTool(
	request: Extract<InvestigationToolRequest, { tool: "getMetrics" }>,
): GetMetricsResult;
export function runInvestigationTool(
	request: Extract<InvestigationToolRequest, { tool: "getServiceHealth" }>,
): GetServiceHealthResult;
export function runInvestigationTool(
	request: Extract<InvestigationToolRequest, { tool: "getRecentDeployments" }>,
): GetRecentDeploymentsResult;
export function runInvestigationTool(
	request: Extract<InvestigationToolRequest, { tool: "getTrace" }>,
): GetTraceResult;
export function runInvestigationTool(request: InvestigationToolRequest): InvestigationToolResult;
export function runInvestigationTool(
	request: InvestigationToolRequest,
): InvestigationToolResult {
	switch (request.tool) {
		case "searchLogs":
			return searchLogs(simulatedProductionEnvironment, request.input);
		case "getMetrics":
			return getMetrics(simulatedProductionEnvironment, request.input);
		case "getServiceHealth":
			return getServiceHealth(simulatedProductionEnvironment, request.input);
		case "getRecentDeployments":
			return getRecentDeployments(simulatedProductionEnvironment, request.input);
		case "getTrace":
			return getTrace(simulatedProductionEnvironment, request.input);
	}
}

function searchLogs(environment: SimulatedProductionEnvironment, input: SearchLogsInput): SearchLogsResult {
	const limit = boundedLimit(input.limit);
	const queryTerms = input.query
		?.toLowerCase()
		.trim()
		.split(/\s+/)
		.filter((term) => term && !(input.level === "error" && term === "error")) ?? [];
	const logs = environment.logs
		.filter((log) => matchesOptional(log.service, input.service))
		.filter((log) => matchesOptional(log.region, input.region))
		.filter((log) => matchesOptional(log.level, input.level))
		.filter((log) => !input.start || log.timestamp >= input.start)
		.filter((log) => !input.end || log.timestamp <= input.end)
		.filter((log) => queryTerms.every((term) => searchableLogText(log).includes(term)))
		.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
		.slice(0, limit);

	return { logs, returned: logs.length };
}

function getMetrics(
	environment: SimulatedProductionEnvironment,
	input: GetMetricsInput,
): GetMetricsResult {
	const series = environment.metrics.filter(
		(metric) =>
			metric.service === input.service &&
			metric.name === input.metric &&
			matchesOptional(metric.region, input.region),
	);

	return { series };
}

function getServiceHealth(
	environment: SimulatedProductionEnvironment,
	input: GetServiceHealthInput,
): GetServiceHealthResult {
	const hasExplicitFilter = Boolean(input.service || input.region);
	const services = environment.serviceHealth.filter(
		(health) =>
			matchesOptional(health.service, input.service) &&
			matchesOptional(health.region, input.region) &&
			(hasExplicitFilter || health.status !== "healthy"),
	);

	return { services };
}

function getRecentDeployments(
	environment: SimulatedProductionEnvironment,
	input: GetRecentDeploymentsInput,
): GetRecentDeploymentsResult {
	const deployments = environment.deployments
		.filter((deployment) => matchesOptional(deployment.service, input.service))
		.filter((deployment) => matchesOptional(deployment.region, input.region))
		.sort((a, b) => b.completedAt.localeCompare(a.completedAt))
		.slice(0, boundedLimit(input.limit));

	return { deployments, returned: deployments.length };
}

function getTrace(
	environment: SimulatedProductionEnvironment,
	input: GetTraceInput,
): GetTraceResult {
	return {
		trace: environment.traces.find((trace) => trace.id === input.traceId) ?? null,
	};
}

function matchesOptional(value: string, filter: string | undefined) {
	return !filter || value === filter;
}

function searchableLogText(log: LogEntry) {
	return `${log.message} ${Object.entries(log.attributes)
		.map(([key, value]) => `${key} ${value}`)
		.join(" ")}`.toLowerCase();
}

function boundedLimit(limit: number | undefined) {
	return Math.max(1, Math.min(limit ?? 50, 100));
}

function metricCatalog() {
	const metrics = new Map<string, Set<string>>();
	for (const metric of simulatedProductionEnvironment.metrics) {
		const key = `${metric.service}:${metric.region}`;
		const names = metrics.get(key) ?? new Set<string>();
		names.add(metric.name);
		metrics.set(key, names);
	}
	return Array.from(metrics.entries())
		.map(([key, names]) => {
			const [service, region] = key.split(":");
			return { service, region, metrics: Array.from(names).sort() };
		})
		.sort((left, right) => `${left.service}:${left.region}`.localeCompare(`${right.service}:${right.region}`));
}
