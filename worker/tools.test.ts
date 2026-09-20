import { describe, expect, it } from "vitest";

import { simulatedProductionEnvironment } from "./fixtures";
import { runInvestigationTool } from "./tools";

describe("simulated production environment", () => {
	it("combines independent observability sources without a stored diagnosis", () => {
		expect(simulatedProductionEnvironment.logs).toHaveLength(10);
		expect(simulatedProductionEnvironment.traces).toHaveLength(3);
		expect(simulatedProductionEnvironment).not.toHaveProperty("rootCause");
	});
});

describe("investigation tools", () => {
	it("searches logs with service, region, and query filters", () => {
		const result = runInvestigationTool({
			tool: "searchLogs",
			input: { service: "cart-service", region: "us-east-1", query: "customerTier" },
		});

		expect(result).toMatchObject({ returned: 1 });
		expect(result.logs[0]).toMatchObject({
			service: "cart-service",
			message: "reservation request rejected by promotion validator",
		});
	});

	it("returns a degraded-service overview when no health filter is supplied", () => {
		const result = runInvestigationTool({ tool: "getServiceHealth", input: {} });

		expect(result.services).toHaveLength(4);
		expect(result.services.every((service) => service.status !== "healthy")).toBe(true);
		expect(result.services.map((service) => service.service)).toContain("checkout-api");
	});

	it("returns only the requested regional metric series", () => {
		const result = runInvestigationTool({
			tool: "getMetrics",
			input: {
				service: "orders-api",
				metric: "http.server.p95_duration",
				region: "eu-west-1",
			},
		});

		expect(result.series).toHaveLength(1);
		expect(result.series[0].points.at(-1)?.value).toBe(5080);
	});

	it("keeps traces and deployments separate evidence sources", () => {
		const traceResult = runInvestigationTool({
			tool: "getTrace",
			input: { traceId: "trace-payment-slow-01" },
		});
		const deploymentResult = runInvestigationTool({
			tool: "getRecentDeployments",
			input: { service: "payments-service" },
		});

		expect(traceResult.trace?.spans).toHaveLength(3);
		expect(deploymentResult.deployments[0]).toMatchObject({ version: "4.7.0" });
	});
});
