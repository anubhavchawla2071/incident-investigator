import type {
	InvestigationModel,
	InvestigationReportDraft,
	ModelDecision,
	StoredToolRun,
} from "./investigation";

type FixtureTarget = "checkout" | "payments" | "orders";

/**
 * A deterministic local stand-in for the future Workers AI adapter.
 * It only receives the reported symptom and completed tool results.
 */
export class FixtureInvestigationModel implements InvestigationModel {
	async decide({ symptom, toolRuns }: { symptom: string; toolRuns: StoredToolRun[] }): Promise<ModelDecision> {
		const target = selectTarget(symptom, toolRuns);
		if (!target) {
			return { kind: "report", report: inconclusiveReport(toolRuns) };
		}

		const followUpCalls = toolRuns.length - 1;
		switch (followUpCalls) {
			case 0:
				return { kind: "tool", request: metricRequest(target) };
			case 1:
				return { kind: "tool", request: logRequest(target) };
			case 2: {
				const traceId = traceIdFrom(toolRuns);
				return traceId
					? { kind: "tool", request: { tool: "getTrace", input: { traceId } } }
					: { kind: "report", report: inconclusiveReport(toolRuns) };
			}
			case 3:
				return { kind: "tool", request: deploymentRequest(target, toolRuns) };
			default:
				return { kind: "report", report: resolvedReport(target, toolRuns) };
		}
	}
}

function selectTarget(symptom: string, toolRuns: StoredToolRun[]): FixtureTarget | null {
	const health = toolRuns.find((toolRun) => toolRun.toolName === "getServiceHealth")?.output;
	if (!health) {
		return null;
	}

	const lowerSymptom = symptom.toLowerCase();
	const healthText = JSON.stringify(health).toLowerCase();
	if ((/orders?/.test(lowerSymptom) || /slow|latency/.test(lowerSymptom) && !/payments?|charge|database|connection/.test(lowerSymptom)) && healthText.includes("orders-api")) {
		return "orders";
	}
	if (/payments?|charge|database|connection/.test(lowerSymptom) && healthText.includes("payments-service")) {
		return "payments";
	}
	if (/500|5xx|checkout|api|error/.test(lowerSymptom) && healthText.includes("checkout-api")) {
		return "checkout";
	}

	return null;
}

function metricRequest(target: FixtureTarget) {
	switch (target) {
		case "checkout":
			return {
				tool: "getMetrics",
				input: { service: "checkout-api", region: "us-east-1", metric: "http.server.error_rate" },
			};
		case "payments":
			return {
				tool: "getMetrics",
				input: { service: "payments-service", region: "us-east-1", metric: "db.pool.active_connections" },
			};
		case "orders":
			return {
				tool: "getMetrics",
				input: { service: "orders-api", region: "eu-west-1", metric: "http.server.p95_duration" },
			};
	}
}

function logRequest(target: FixtureTarget) {
	switch (target) {
		case "checkout":
			return { tool: "searchLogs", input: { service: "checkout-api", region: "us-east-1", query: "reservation" } };
		case "payments":
			return { tool: "searchLogs", input: { service: "payments-service", region: "us-east-1", query: "connection" } };
		case "orders":
			return { tool: "searchLogs", input: { service: "orders-api", region: "eu-west-1", query: "inventory" } };
	}
}

function deploymentRequest(target: FixtureTarget, toolRuns: StoredToolRun[]) {
	if (target === "checkout") {
		return {
			tool: "getRecentDeployments",
			input: { service: upstreamServiceFrom(toolRuns) ?? "cart-service", region: "us-east-1", limit: 3 },
		};
	}

	return {
		tool: "getRecentDeployments",
		input:
			target === "payments"
				? { service: "payments-service", region: "us-east-1", limit: 3 }
				: { service: "orders-api", region: "eu-west-1", limit: 3 },
	};
}

function traceIdFrom(toolRuns: StoredToolRun[]) {
	const logs = toolRuns.find((toolRun) => toolRun.toolName === "searchLogs")?.output;
	return JSON.stringify(logs).match(/"traceId":"([^"]+)"/)?.[1];
}

function upstreamServiceFrom(toolRuns: StoredToolRun[]) {
	const logs = toolRuns.find((toolRun) => toolRun.toolName === "searchLogs")?.output;
	return JSON.stringify(logs).match(/"upstream":"([^"]+)"/)?.[1];
}

function resolvedReport(target: FixtureTarget, toolRuns: StoredToolRun[]): InvestigationReportDraft {
	const evidenceToolRunIds = toolRuns.map((toolRun) => toolRun.id);
	switch (target) {
		case "checkout":
			return {
				outcome: "resolved",
				diagnosis: "Checkout 500s originate in cart reservation validation in us-east-1.",
				rootCause: "cart-service 2.14.0 tightened the promotion request contract, while checkout still omits customerTier.",
				confidence: 0.94,
				suggestedNextSteps: ["Roll back or patch cart-service 2.14.0.", "Send customerTier from checkout before re-enabling the contract."],
				evidenceToolRunIds,
			};
		case "payments":
			return {
				outcome: "resolved",
				diagnosis: "Payment confirmations are failing while waiting for primary database connections.",
				rootCause: "The payments primary connection pool is exhausted after the 4.7.0 retry-transaction change.",
				confidence: 0.93,
				suggestedNextSteps: ["Roll back or mitigate the 4.7.0 transaction change.", "Increase pool headroom only after confirming the connection leak or longer transaction."],
				evidenceToolRunIds,
			};
		case "orders":
			return {
				outcome: "resolved",
				diagnosis: "Orders in eu-west-1 are timing out before inventory reservation completes.",
				rootCause: "orders-api 9.12.0 selects the inventory-us.internal endpoint from eu-west-1 instead of a regional endpoint.",
				confidence: 0.95,
				suggestedNextSteps: ["Roll back or correct the eu-west-1 inventory endpoint configuration.", "Add a regional endpoint selection check to the deployment validation."],
				evidenceToolRunIds,
			};
	}
}

function inconclusiveReport(toolRuns: StoredToolRun[]): InvestigationReportDraft {
	return {
		outcome: "inconclusive",
		diagnosis: "The reported symptom does not match a clearly degraded service in the simulated environment.",
		rootCause: "Inconclusive with the available evidence.",
		confidence: 0.2,
		suggestedNextSteps: ["Share the affected endpoint, region, or a recent error timestamp."],
		evidenceToolRunIds: toolRuns.map((toolRun) => toolRun.id),
	};
}
