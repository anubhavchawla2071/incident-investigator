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
	constructor(private readonly ai: WorkersAiBinding) { }

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
			const rawResponse = await this.ai.run(INVESTIGATION_MODEL, request);

			return {
				kind: "report",
				report: parseReport(asResponse(rawResponse).response),
			};
		} catch (error) {
			if (!(error instanceof InvalidReportJsonError)) throw error;
		}

		try {
			const retryRequest = finalReportRequest(evidence, "Previous response was not valid JSON. Return only corrected JSON matching the required schema.");
			const rawResponse = await this.ai.run(INVESTIGATION_MODEL, retryRequest);

			return {
				kind: "report",
				report: parseReport(asResponse(rawResponse).response),
			};
		} catch (error) {
			if (error instanceof InvalidReportJsonError) {
				throw new Error("Workers AI final report was not valid JSON after one retry.");
			}
			throw error;
		}
	}
}

const investigationSystemPrompt = `You are an incident investigator. Your only evidence is the user symptom, service catalog, and completed tool results supplied in this conversation. Never assume access to raw observability fixtures or undisclosed logs, metrics, traces, or deployments.

Choose exactly one next investigation tool when more evidence is needed. You decide which evidence is relevant; there is no fixed investigation sequence. Do not diagnose from one isolated signal, but stop investigating as soon as the evidence supports a diagnosis. The orchestrator already starts every investigation with getServiceHealth and provides its result to you. You must use that result as initial triage and must not attempt to call getServiceHealth yourself.

Investigation policy:
- Investigate the user's symptom, not every degraded service in the health overview.
- If the user names a service or region, stay focused there unless completed evidence links another service or dependency.
- Choose metrics only from availableMetricsByService for the selected service and region.
- Call getTrace only with a traceId that appeared in completed tool results. Never invent trace IDs.
- Do not repeat a tool call with the same input.
- Treat service health as triage and a metric as symptom confirmation, not a root-cause diagnosis. When a metric confirms the symptom, the next call should usually be searchLogs for that same service and region.
- If matching logs contain a traceId, the next call should usually be getTrace using that observed ID. If logs or a trace identify an upstream, peer, or dependency, inspect that implicated service only when the completed evidence links it to the symptom.
- After a trace identifies the failure mechanism, check recent deployments for the implicated service before resolving the incident. Do not finalize from health plus a metric alone unless the user explicitly asked only for a quick status check.
- Policy feedback means a requested call was rejected and produced no incident evidence. Choose a different compliant call; never cite policy feedback as evidence or repeat it.

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
	const completedToolRuns = usableToolRuns(toolRuns);
	return {
		reportedSymptom: symptom,
		serviceCatalog,
		degradedServiceHealth: degradedServiceHealth(toolRuns),
		availableMetrics: allowedMetricNames,
		availableMetricsByService,
		completedToolResults: completedToolRuns
			.filter((toolRun) => toolRun.toolName !== "getServiceHealth")
			.map((toolRun) => ({
				toolRunId: toolRun.id,
				tool: toolRun.toolName,
				input: toolRun.input,
				result: toolRun.output,
			})),
		policyFeedback: rejectedToolRuns(toolRuns).map((toolRun) => ({
			toolRunId: toolRun.id,
			tool: toolRun.toolName,
			input: toolRun.input,
			reason: policyReason(toolRun.output),
		})),
	};
}

function degradedServiceHealth(toolRuns: StoredToolRun[]) {
	const output = toolRuns.find((toolRun) => toolRun.toolName === "getServiceHealth")?.output;
	return isRecord(output) && Array.isArray(output.services) ? output.services : [];
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
	const completedRuns = usableToolRuns(toolRuns);
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

function usableToolRuns(toolRuns: StoredToolRun[]) {
	return toolRuns.filter((toolRun) => toolRun.status === "succeeded" && toolRun.output && !isPolicyResult(toolRun.output));
}

function rejectedToolRuns(toolRuns: StoredToolRun[]) {
	return toolRuns.filter((toolRun) => toolRun.status === "succeeded" && toolRun.output && isPolicyResult(toolRun.output));
}

function policyReason(output: StoredToolRun["output"]) {
	if (!isPolicyResult(output)) return "";
	return typeof output.policy.reason === "string" ? output.policy.reason : "The requested tool call was rejected.";
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
    const trimmed = value.trim();

    // Normal JSON
    try {
        return JSON.parse(trimmed);
    } catch {
        // Continue below.
    }

    // JSON wrapped in ```json ... ``` or ``` ... ```
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

    if (fenced?.[1]) {
        try {
            return JSON.parse(fenced[1].trim());
        } catch {
            // Continue to the final error.
        }
    }

    throw new InvalidReportJsonError();
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

function isPolicyResult(value: unknown): value is { policy: { status: string; reason?: unknown } } {
	return isRecord(value) && isRecord(value.policy) && value.policy.status === "rejected";
}

function isReportOutcome(value: unknown): value is InvestigationReportDraft["outcome"] {
	return value === "resolved" || value === "inconclusive";
}
