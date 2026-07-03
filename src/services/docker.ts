import Docker from "dockerode";
import { 
  CustomContainerInfo, 
  DockerLabelConfig, 
  DockerTunnelConfig,
  dockerLabelConfigSchema,
  dockerTunnelConfigSchema,
  TunnelOriginRequest
} from "../schemas";
import { logger } from "../utils/logger";

export class DockerService {
  private docker: Docker;
  private domain: string;

  // Type-safe parser configuration
  private static originRequestParsers: Record<keyof TunnelOriginRequest, (value: string) => any> = {
    http2Origin: (value) => value.toLowerCase() === 'true',
    noTLSVerify: (value) => value.toLowerCase() === 'true',
    disableChunkedEncoding: (value) => value.toLowerCase() === 'true',
    noHappyEyeballs: (value) => value.toLowerCase() === 'true',
    connectTimeout: (value) => parseInt(value),
    keepAliveConnections: (value) => parseInt(value),
    keepAliveTimeout: (value) => parseInt(value),
    tcpKeepAlive: (value) => parseInt(value),
    tlsTimeout: (value) => parseInt(value),
    httpHostHeader: (value) => value,
    originServerName: (value) => value,
    proxyType: (value) => value
  };

  constructor(domain: string) {
    this.docker = new Docker();
    this.domain = domain;
  }

  async getContainerInfo(): Promise<CustomContainerInfo[]> {
    const containers = await this.docker.listContainers({ all: true });
    return containers.map((container) => ({
      ...container,
      created: new Date(container.Created * 1000).toISOString(),
    }));
  }

  // Streams container lifecycle events (start/die/stop/destroy) instead of
  // relying on a polling interval. A fixed-interval snapshot comparison can
  // miss a transition entirely if a container restarts faster than the
  // interval (reproduced with a <1s restart against a 1s poll) -- the Docker
  // events API guarantees delivery of every state change as it happens.
  async subscribeToEvents(
    onEvent: (containerId: string, action: string) => void
  ): Promise<void> {
    const stream = await this.docker.getEvents({
      filters: { type: ["container"], event: ["start", "die", "stop", "destroy"] },
    });
    // Docker's event stream is newline-delimited JSON, but TCP chunk
    // boundaries don't align with event boundaries -- a single "data" event
    // can contain a partial JSON object, several complete ones, or both.
    // Buffer until we have full lines and only parse those.
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // last entry may be an incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.Actor?.ID) {
            onEvent(event.Actor.ID, event.Action);
          }
        } catch (err) {
          logger.error({ err, line }, "Failed to parse Docker event");
        }
      }
    });
    stream.on("error", (err: Error) => {
      logger.error({ err }, "Docker event stream error");
    });
  }

  private parseDotNotationLabels(labels: Record<string, string>): DockerLabelConfig {
    const config: DockerLabelConfig = {
      originRequest: {}  // Initialize with empty object to avoid undefined
    };

    for (const [key, value] of Object.entries(labels)) {
      if (!key.startsWith('tunneldock.')) continue;

      const path = key.split('.');
      if (path.length < 2) continue;

      switch (path[1]) {
        case 'hostname':
          config.hostname = value;
          break;
        case 'assign':
          config.assign = value.toLowerCase() === 'true';
          break;
        case 'service':
          if (!config.service) config.service = { protocol: 'http' };
          if (path.length < 3) continue;
          
          switch (path[2]) {
            case 'protocol':
              config.service.protocol = value;
              break;
            case 'port':
              config.service.port = parseInt(value);
              break;
            case 'path':
              config.service.path = value;
              break;
          }
          break;
        case 'originRequest':
          if (path.length < 3) continue;
          const setting = path[2] as keyof TunnelOriginRequest;
          const parser = DockerService.originRequestParsers[setting];
          
          if (parser && config.originRequest) {
            config.originRequest[setting] = parser(value);
          }
          break;
      }
    }

    return dockerLabelConfigSchema.parse(config);
  }

  async shouldManageTunnel(container: CustomContainerInfo, previousState?: string): Promise<{
    shouldManage: boolean;
    config?: DockerTunnelConfig;
  }> {
    const labels = container.Labels || {};
    const config = this.parseDotNotationLabels(labels);

    if (!config.assign) {
      return { shouldManage: false };
    }

    const containerName = container.Names[0].replace("/", "");
    let hostname: string;
    const hostnameNeededDomainAppended =
      !!config.hostname && !config.hostname.endsWith(this.domain);

    if (config.hostname) {
      hostname = hostnameNeededDomainAppended
        ? `${config.hostname}.${this.domain}`
        : config.hostname;
    } else {
      hostname = `${containerName}.${this.domain}`;
    }

    const port = config.service?.port || container.Ports?.[0]?.PublicPort || 80;
    const protocol = config.service?.protocol || 'http';
    const path = config.service?.path || '';

    // Not "localhost": cloudflared runs in its own container, so the origin
    // must be reachable by the *managed* container's Docker network name.
    let service = `${protocol}://${containerName}:${port}`;
    if (path) {
      service += path.startsWith('/') ? path : `/${path}`;
    }

    if (previousState !== container.State && container.State === "running") {
      const tunnelConfig = dockerTunnelConfigSchema.parse({
        containerName,
        hostname,
        port,
        service,
        originRequest: config.originRequest
      });

      return {
        shouldManage: true,
        config: tunnelConfig
      };
    }

    return { shouldManage: false };
  }
}