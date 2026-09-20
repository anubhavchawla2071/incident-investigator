export type ServiceStatus = "healthy" | "degraded" | "unhealthy";
export type TraceStatus = "ok" | "error";

export interface LogEntry {
	id: string;
	timestamp: string;
	service: string;
	region: string;
	level: "debug" | "info" | "warn" | "error";
	message: string;
	attributes: Record<string, string | number | boolean>;
}

export interface MetricSeries {
	service: string;
	region: string;
	name: string;
	unit: string;
	points: Array<{ timestamp: string; value: number }>;
}

export interface TraceSpan {
	spanId: string;
	parentSpanId: string | null;
	service: string;
	operation: string;
	durationMs: number;
	status: TraceStatus;
	attributes: Record<string, string | number | boolean>;
}

export interface Trace {
	id: string;
	region: string;
	rootService: string;
	startedAt: string;
	durationMs: number;
	status: TraceStatus;
	spans: TraceSpan[];
}

export interface Deployment {
	id: string;
	service: string;
	version: string;
	region: string;
	completedAt: string;
	status: "succeeded" | "failed" | "rolled_back";
	summary: string;
	changes: string[];
}

export interface HealthCheck {
	name: string;
	status: ServiceStatus;
	detail: string;
}

export interface ServiceHealth {
	service: string;
	region: string;
	status: ServiceStatus;
	observedAt: string;
	checks: HealthCheck[];
}

export interface ObservabilityFixture {
	logs: LogEntry[];
	metrics: MetricSeries[];
	traces: Trace[];
	deployments: Deployment[];
	serviceHealth: ServiceHealth[];
}

export type SimulatedProductionEnvironment = ObservabilityFixture;
