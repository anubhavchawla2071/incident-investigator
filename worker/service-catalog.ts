export const serviceCatalog = [
	{ service: "checkout-api", regions: ["us-east-1"], description: "Public checkout API." },
	{ service: "cart-service", regions: ["us-east-1"], description: "Cart and reservation service." },
	{ service: "payments-service", regions: ["us-east-1"], description: "Payment authorization and confirmation service." },
	{ service: "fraud-service", regions: ["us-east-1"], description: "Fraud decision service." },
	{ service: "orders-api", regions: ["eu-west-1", "us-east-1"], description: "Order creation API." },
	{ service: "inventory-service", regions: ["eu-west-1"], description: "Inventory reservation service." },
] as const;
