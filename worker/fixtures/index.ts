import checkoutCartContractRegression from "./checkout-cart-contract-regression.json";
import ordersRegionalInventoryTimeout from "./orders-regional-inventory-timeout.json";
import paymentsDbPoolExhaustion from "./payments-db-pool-exhaustion.json";
import type { ObservabilityFixture, SimulatedProductionEnvironment } from "./types";

const observabilityFixtureFiles = [
	checkoutCartContractRegression,
	paymentsDbPoolExhaustion,
	ordersRegionalInventoryTimeout,
] as unknown as ObservabilityFixture[];

export const simulatedProductionEnvironment: SimulatedProductionEnvironment = {
	logs: observabilityFixtureFiles.flatMap((fixture) => fixture.logs),
	metrics: observabilityFixtureFiles.flatMap((fixture) => fixture.metrics),
	traces: observabilityFixtureFiles.flatMap((fixture) => fixture.traces),
	deployments: observabilityFixtureFiles.flatMap((fixture) => fixture.deployments),
	serviceHealth: observabilityFixtureFiles.flatMap((fixture) => fixture.serviceHealth),
};
