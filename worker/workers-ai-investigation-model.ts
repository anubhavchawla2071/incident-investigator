import { FixtureInvestigationModel } from "./fixture-investigation-model";
import type {
	InvestigationModel,
	InvestigationReportDraft,
	ModelDecision,
	StoredToolRun,
} from "./investigation";
import { serviceCatalog } from "./service-catalog";
import { allowedMetricNames, availableMetricsByService } from "./tools";

export const INVESTIGATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface WorkersAiBinding {
	run(model: string, input: WorkersAiRequest): Promise<unknown>;
}

interface WorkersAiRequest {
	messages: Array<{ role: "system" | "user"; content: string }>;
	tools?: ToolDefinition[];
	temperature: number;
	max_tokens: number;
}

interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

interface WorkersAiResponse {
	response?: unknown;
	tool_calls?: Array<{ name?: unknown; arguments?: unknown }>;
}

export function createInvestigationModel(ai?: WorkersAiBinding): InvestigationModel {
	return ai ? new WorkersAiInvestigationModel(ai) : new FixtureInvestigationModel();
}

export class WorkersAiInvestigationModel implements InvestigationModel {
	constructor(private readonly ai: WorkersAiBinding) {}

	async decide(input: { symptom: string; toolRuns: StoredToolRun[]; finalReportRequired?: boolean }): Promise<ModelDecision> {
		if (input.finalReportRequired) {
			return this.writeFinalReport(input.toolRuns);
		}

		const request: WorkersAiRequest = {
			messages: [
				{ role: "system", content: investigationSystemPrompt },
				{ role: "user", content: JSON.stringify(toModelContext(input)) },
			],
			temperature: 0.1,
			max_tokens: 900,
			tools: investigationToolSchemas,
		};

		const response = asResponse(await this.ai.run(INVESTIGATION_MODEL, request));

		if (response.tool_calls?.length) {
			const [toolCall] = response.tool_calls;
			if (typeof toolCall?.name !== "string") {
				throw new Error("Workers AI returned a tool call without a name.");
			}
			return {
				kind: "tool",
				request: { tool: toolCall.name, input: toolCall.arguments ?? {} },
			};
		}

		return { kind: "report", report: parseReport(response.response) };
	}

	private async writeFinalReport(toolRuns: StoredToolRun[]): Promise<ModelDecision> {
		const evidence = toFinalReportContext(toolRuns);
		const request = finalReportRequest(evidence);

		try {
			return { kind: "report", report: parseReport((asResponse(await this.ai.run(INVESTIGATION_MODEL, request))).response) };
		} catch (error) {
			if (!(error instanceof InvalidReportJsonError)) throw error;
		}

		try {
			const retryRequest = finalReportRequest(evidence, "Previous response was not valid JSON. Return only corrected JSON matching the required schema.");
			return { kind: "report", report: parseReport((asResponse(await this.ai.run(INVESTIGATION_MODEL, retryRequest))).response) };
		} catch (error) {
			if (error instanceof InvalidReportJsonError) {
				throw new Error("Workers AI final report was not valid JSON after one retry.");
			}
			throw error;
		}
	}
}

const investigationSystemPrompt = `You are an incident investigator. Your only evidence is the user symptom, service catalog, and completed tool results supplied in this conversation. Never assume access to raw observability fixtures or undisclosed logs, metrics, traces, or deployments.

Choose exactly one next investigation tool when more evidence is needed. Do not diagnose from one isolated signal. Gather corroborating evidence appropriate to the hypothesis, but do not use a fixed tool count. The orchestrator already starts every investigation with getServiceHealth and enforces the overall call limit. When finalReportRequired is true, do not call a tool; write the best supported final report from the completed evidence.

Investigation policy:
- Keep the investigation focused on the user-reported service, region, and symptom. Do not jump to another degraded service from the health overview unless the symptom or prior tool evidence connects that service.
- For checkout 500s, after checkout http.server.error_rate is confirmed, search checkout logs for errors before requesting more metrics.
- Call getTrace only with a traceId that appeared in completed tool results. Never invent trace IDs.
- If logs or traces show an upstream service, you may inspect that upstream service's trace or recent deployments.
- For getMetrics, use only metric names that are listed for that service and region in availableMetricsByService.

When evidence is sufficient, return only a JSON object with this shape: {"outcome":"resolved"|"inconclusive","diagnosis":"string","rootCause":"string","confidence":number from 0 to 1,"suggestedNextSteps":["string"],"evidenceToolRunIds":["tool run id"]}. Cite only IDs from completed tool results. If evidence is insufficient, return outcome "inconclusive" instead of guessing.`;

const investigationToolSchemas: ToolDefinition[] = [
	{
		name: "searchLogs",
		description: "Search production logs by optional service, region, query, and time window.",
		parameters: objectSchema({
			service: stringSchema("Service name from the catalog."),
			region: stringSchema("Cloud region."),
			query: stringSchema("Words to match in a log message or attributes."),
			level: stringSchema("Optional log level: debug, info, warn, or error."),
			start: stringSchema("Inclusive ISO timestamp."),
			end: stringSchema("Inclusive ISO timestamp."),
			limit: { type: "number", description: "Maximum entries to return." },
		}),
	},
	{
		name: "getMetrics",
		description: "Return a requested metric series for one service and optional region.",
		parameters: objectSchema({
			service: stringSchema("Service name from the catalog."),
			metric: stringSchema(`Metric name to retrieve. Use exactly one of: ${allowedMetricNames.join(", ")}.`),
			region: stringSchema("Cloud region."),
		}, ["service", "metric"]),
	},
	{
		name: "getServiceHealth",
		description: "Return degraded services when no filters are supplied, or health for a specific service or region.",
		parameters: objectSchema({ service: stringSchema("Service name from the catalog."), region: stringSchema("Cloud region.") }),
	},
	{
		name: "getRecentDeployments",
		description: "List recent deployments for an optional service and region.",
		parameters: objectSchema({
			service: stringSchema("Service name from the catalog."),
			region: stringSchema("Cloud region."),
			limit: { type: "number", description: "Maximum deployments to return." },
		}),
	},
	{
		name: "getTrace",
		description: "Fetch a distributed trace by the trace ID observed in prior tool results.",
		parameters: objectSchema({ traceId: stringSchema("Trace ID from a prior tool result.") }, ["traceId"]),
	},
];

function toModelContext({ symptom, toolRuns }: {
	symptom: string;
	toolRuns: StoredToolRun[];
}) {
	return {
		reportedSymptom: symptom,
		serviceCatalog,
		availableMetrics: allowedMetricNames,
		availableMetricsByService,
		completedToolResults: toolRuns
			.filter((toolRun) => toolRun.status === "succeeded")
			.map((toolRun) => ({
				toolRunId: toolRun.id,
				tool: toolRun.toolName,
				input: toolRun.input,
				result: toolRun.output,
			})),
	};
}

const finalReportSystemPrompt = `You are writing the final report for an incident investigation. Use only the compact evidence summary and cite only IDs from evidenceToolRunIds. Do not call tools. Return only JSON matching reportSchema, with no markdown or extra text.`;

function finalReportRequest(evidence: ReturnType<typeof toFinalReportContext>, correction?: string): WorkersAiRequest {
	return {
		messages: [
			{ role: "system", content: finalReportSystemPrompt },
			{ role: "user", content: JSON.stringify({ ...evidence, correction }) },
		],
		temperature: 0,
		max_tokens: 450,
	};
}

function toFinalReportContext(toolRuns: StoredToolRun[]) {
	const completedRuns = toolRuns.filter((toolRun) => toolRun.status === "succeeded" && toolRun.output);
	return {
		evidenceSummary: completedRuns.map(summarizeEvidence).filter((summary): summary is string => Boolean(summary)),
		evidenceToolRunIds: completedRuns.map((toolRun) => toolRun.id),
		reportSchema: {
			outcome: "resolved or inconclusive",
			diagnosis: "string",
			rootCause: "string",
			confidence: "number from 0 to 1",
			suggestedNextSteps: ["string"],
			evidenceToolRunIds: ["tool run id"],
		},
	};
}

function summarizeEvidence(toolRun: StoredToolRun): string | null {
	const output = isRecord(toolRun.output) ? toolRun.output : null;
	if (!output) return null;

	if (toolRun.toolName === "getMetrics" && Array.isArray(output.series)) {
		const series = output.series[0];
		if (!isRecord(series) || !Array.isArray(series.points) || series.points.length < 2) return null;
		const first = series.points[0];
		const last = series.points.at(-1);
		if (!isRecord(first) || !isRecord(last)) return null;
		return `${String(series.service)} ${String(series.region)} ${String(series.name)} increased from ${String(first.value)}${series.unit === "percent" ? "%" : ""} to ${String(last.value)}${series.unit === "percent" ? "%" : ""}.`;
	}

	if (toolRun.toolName === "searchLogs" && Array.isArray(output.logs)) {
		const log = output.logs.find(isRecord);
		if (!log || !isRecord(log.attributes)) return null;
		return `${String(log.service)} log ${String(log.id)} shows statusCode ${String(log.attributes.statusCode)}, upstream ${String(log.attributes.upstream)}, traceId ${String(log.attributes.traceId)}.`;
	}

	if (toolRun.toolName === "getTrace" && isRecord(output.trace) && Array.isArray(output.trace.spans)) {
		const failedSpan = output.trace.spans.find((span) => isRecord(span) && span.status === "error" && isRecord(span.attributes) && span.attributes.errorType);
		if (!isRecord(failedSpan) || !isRecord(failedSpan.attributes)) return null;
		return `Trace ${String(output.trace.id)} shows ${String(failedSpan.service)} ${String(failedSpan.operation)} failed with ${String(failedSpan.attributes.errorType)}.`;
	}

	if (toolRun.toolName === "getRecentDeployments" && Array.isArray(output.deployments)) {
		const deployment = output.deployments[0];
		if (!isRecord(deployment)) return null;
		const changes = Array.isArray(deployment.changes) ? deployment.changes.map(String).join(" ") : "";
		return `${String(deployment.service)} deployment ${String(deployment.id)} version ${String(deployment.version)} completed at ${String(deployment.completedAt)} and changed ${changes}`;
	}

	return null;
}

function parseReport(response: unknown): InvestigationReportDraft {
	const value = typeof response === "string" ? parseJsonObject(response) : response;
	if (!isRecord(value) || !isReportOutcome(value.outcome) || typeof value.diagnosis !== "string" || typeof value.rootCause !== "string" || typeof value.confidence !== "number" || !Array.isArray(value.suggestedNextSteps) || !Array.isArray(value.evidenceToolRunIds)) {
		throw new Error("Workers AI did not return a valid final report.");
	}

	return {
		outcome: value.outcome,
		diagnosis: value.diagnosis,
		rootCause: value.rootCause,
		confidence: value.confidence,
		suggestedNextSteps: value.suggestedNextSteps as string[],
		evidenceToolRunIds: value.evidenceToolRunIds as string[],
	};
}

function parseJsonObject(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new InvalidReportJsonError();
	}
}

class InvalidReportJsonError extends Error {
	constructor() {
		super("Workers AI final response was not valid JSON.");
	}
}

function asResponse(value: unknown): WorkersAiResponse {
	if (!isRecord(value)) {
		throw new Error("Workers AI returned an unexpected response.");
	}
	return value as WorkersAiResponse;
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
	return { type: "object", properties, required };
}

function stringSchema(description: string) {
	return { type: "string", description };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReportOutcome(value: unknown): value is InvestigationReportDraft["outcome"] {
	return value === "resolved" || value === "inconclusive";
}
