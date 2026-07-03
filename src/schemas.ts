import { z } from "zod";

// Base schemas for reuse
const timestampSchema = z.string().datetime();

const portSchema = z.object({
  IP: z.string().optional(),
  PrivatePort: z.number(),
  PublicPort: z.number().optional(),
  Type: z.string(),
});

// TunnelOriginRequest schema
export const tunnelOriginRequestSchema = z.object({
  connectTimeout: z.number().optional(),
  disableChunkedEncoding: z.boolean().optional(),
  http2Origin: z.boolean().optional(),
  httpHostHeader: z.string().optional(),
  keepAliveConnections: z.number().optional(),
  keepAliveTimeout: z.number().optional(),
  noHappyEyeballs: z.boolean().optional(),
  noTLSVerify: z.boolean().optional(),
  originServerName: z.string().optional(),
  proxyType: z.string().optional(),
  tcpKeepAlive: z.number().optional(),
  tlsTimeout: z.number().optional(),
});

// Base tunnel schema with common properties
const baseTunnelSchema = z.object({
  hostname: z.string(),
  service: z.string(),
});

export const tunnelConfigSchema = baseTunnelSchema.extend({
  originRequest: tunnelOriginRequestSchema.optional(),
});

export const customContainerInfoSchema = z.object({
  Id: z.string(),
  Names: z.array(z.string()),
  Image: z.string(),
  State: z.string(),
  Status: z.string(),
  NetworkSettings: z.any(),
  Ports: z.array(portSchema).optional(),
  Labels: z.record(z.string()).optional(),
  Mounts: z.array(z.any()).optional(),
  created: timestampSchema,
});

// Tunnel record schema with common properties
const baseTunnelRecordSchema = baseTunnelSchema.extend({
  lastSync: timestampSchema,
});

// Create a separate schema for tunnel updates
export const tunnelUpdateSchema = baseTunnelSchema.extend({
  tunnelId: z.string(),
  configStatus: z.string(),
  dnsStatus: z.string().optional(),
  originRequest: tunnelOriginRequestSchema.optional(),
  accessAppId: z.string().optional(),
});

// Domain record schema
const domainRecordSchema = z.object({
  hostname: z.string(),
  target: z.string(),
  lastSync: timestampSchema,
  status: z.string(),
});

// Tunnel record schema extends base with additional fields
const tunnelRecordSchema = baseTunnelRecordSchema.extend({
  tunnelId: z.string(),
  dnsStatus: z.string().optional(),
  configStatus: z.string(),
  // ISO timestamp of when this hostname was first observed as inactive.
  // Cleared once active again; only deleted once older than the configured
  // grace period. Absent/undefined means "currently active, not stale".
  staleSince: z.string().optional(),
  // ID of the Access Application tunneldock itself created for this
  // hostname (via tunneldock.access), if any. Only ever set/cleared by
  // tunneldock -- Access apps we didn't create are never touched, so this
  // being unset doesn't mean "unprotected", just "not ours to manage".
  accessAppId: z.string().optional(),
});

// Docker label configuration schemas
export const dockerServiceSchema = z.object({
  protocol: z.string().default('http'),
  port: z.number().optional(),
  path: z.string().optional()
});

export const dockerLabelConfigSchema = z.object({
  hostname: z.string().optional(),
  assign: z.boolean().optional(),
  access: z.string().optional(),
  service: dockerServiceSchema.optional(),
  originRequest: tunnelOriginRequestSchema.optional()
});

export const dockerTunnelConfigSchema = z.object({
  containerName: z.string(),
  hostname: z.string(),
  port: z.number(),
  service: z.string(),
  access: z.string().optional(),
  originRequest: tunnelOriginRequestSchema.optional()
});

// Main data schema
export const tunnelDockDataSchema = z.object({
  timestamp: timestampSchema,
  containers: z.array(customContainerInfoSchema),
  tunnels: z.record(tunnelRecordSchema),
  domains: z.record(domainRecordSchema),
});

// Type exports
export type TunnelOriginRequest = z.infer<typeof tunnelOriginRequestSchema>;
export type TunnelConfig = z.infer<typeof tunnelConfigSchema>;
export type CustomContainerInfo = z.infer<typeof customContainerInfoSchema>;
export type TunnelDockData = z.infer<typeof tunnelDockDataSchema>;
export type TunnelUpdate = z.infer<typeof tunnelUpdateSchema>;

// Additional type exports
export type DockerServiceConfig = z.infer<typeof dockerServiceSchema>;
export type DockerLabelConfig = z.infer<typeof dockerLabelConfigSchema>;
export type DockerTunnelConfig = z.infer<typeof dockerTunnelConfigSchema>;
