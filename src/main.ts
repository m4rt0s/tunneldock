import { DockerService } from "./services/docker";
import { CloudflareService } from "./services/cloudflare";
import { DataService } from "./services/data";
import { CustomContainerInfo } from "./types";
import { logger } from "./utils/logger";

class TunnelDock {
  private dockerService!: DockerService;
  private cloudflareService: CloudflareService;
  private dataService: DataService;
  private tunnelId: string;
  private watchInterval: number;

  constructor() {
    this.validateEnvironment();
    this.cloudflareService = new CloudflareService();
    this.dataService = new DataService();
    this.tunnelId = process.env.CF_TUNNEL_ID || "";
    this.watchInterval = parseInt(
      process.env.TUNNELDOCK_WATCH_INTERVAL || "1000"
    );
  }

  private validateEnvironment(): void {
    const requiredEnvVars = ["CF_ACCOUNT_ID", "CF_TUNNEL_ID", "CF_ZONE_ID"];

    const missingVars = requiredEnvVars.filter(
      (varName) => !process.env[varName]
    );
    if (missingVars.length > 0) {
      logger.error({ missingVars }, "Missing required environment variables");
      process.exit(1);
    }

    const hasToken = !!process.env.CF_API_TOKEN;
    const hasLegacyKey = !!(process.env.CF_API_KEY && process.env.CF_API_EMAIL);
    if (!hasToken && !hasLegacyKey) {
      logger.error(
        "Missing Cloudflare credentials: set CF_API_TOKEN, or both " +
          "CF_API_KEY and CF_API_EMAIL"
      );
      process.exit(1);
    }

    // Log optional configurations
    logger.info(
      {
        watchInterval: this.watchInterval,
      },
      "Optional configurations loaded"
    );
  }

  async syncContainer(
    container: CustomContainerInfo,
    previousState?: string
  ): Promise<void> {
    const { shouldManage, config } =
      await this.dockerService.shouldManageTunnel(container, previousState);

    if (shouldManage && config) {
      logger.info(
        { containerName: config.containerName, state: container.State, config },
        `Container state change detected`
      );

      try {
        // First update tunnel config
        await this.cloudflareService.updateTunnelConfig(this.tunnelId, {
          hostname: config.hostname,
          service: config.service,
          originRequest: config.originRequest,
        });

        // Update tunnel data with config status
        this.dataService.updateTunnelData(config.hostname, {
          hostname: config.hostname,
          tunnelId: this.tunnelId,
          service: config.service,
          configStatus: "updated",
        });

        // Then handle DNS
        const dnsStatus = await this.cloudflareService.manageDNSRecord(
          config.hostname,
          this.tunnelId
        );

        // Update tunnel data again with DNS status
        this.dataService.updateTunnelData(config.hostname, {
          hostname: config.hostname,
          tunnelId: this.tunnelId,
          service: config.service,
          configStatus: "updated",
          dnsStatus: dnsStatus,
        });

        logger.info({ hostname: config.hostname }, `Configuration completed`);
      } catch (error) {
        logger.error(
          { err: error, hostname: config.hostname },
          `Error configuring tunnel`
        );
      }
    }
  }

  private async cleanupStaleRecords(
    containers: CustomContainerInfo[]
  ): Promise<void> {
    const currentData = this.dataService.loadData();
    const activeHostnames = new Set<string>();

    // Collect active hostnames from running containers
    for (const container of containers) {
      const { config } = await this.dockerService.shouldManageTunnel(container);
      if (config) {
        activeHostnames.add(config.hostname);
      }
    }

    // Find and remove stale tunnels and domains
    const staleHostnames = Object.keys(currentData.tunnels).filter(
      (hostname) => !activeHostnames.has(hostname)
    );

    for (const hostname of staleHostnames) {
      logger.info(
        { hostname },
        "Cleaning up stale tunnel configuration and records"
      );

      try {
        await this.cloudflareService.deleteTunnelConfig(
          hostname,
          this.tunnelId
        );

        // Remove local records
        delete currentData.tunnels[hostname];
        if (currentData.domains[hostname]) {
          delete currentData.domains[hostname];
        }

        logger.info(
          { hostname },
          "Successfully cleaned up tunnel configuration and records"
        );
      } catch (error) {
        logger.error(
          { err: error, hostname },
          "Error cleaning up tunnel configuration"
        );
      }
    }

    if (staleHostnames.length > 0) {
      this.dataService.saveData({
        ...currentData,
        timestamp: new Date().toISOString(),
      });
      logger.info({ staleHostnames }, "Cleaned up stale records");
    }
  }

  // One full pass: sync any container that transitioned to running since
  // `previousContainers`, then clean up anything that's no longer active.
  // Shared by both the event-triggered path and the fallback interval below,
  // so a Docker event and a periodic tick behave identically.
  private async runReconciliationPass(
    previousContainers: CustomContainerInfo[]
  ): Promise<CustomContainerInfo[]> {
    const containers = await this.dockerService.getContainerInfo();
    const currentData = this.dataService.loadData();

    this.dataService.saveData({
      timestamp: new Date().toISOString(),
      containers,
      tunnels: currentData.tunnels || {},
      domains: currentData.domains || {},
    });

    for (const container of containers) {
      const previousContainer = previousContainers.find(
        (prev) => prev.Names[0] === container.Names[0]
      );
      await this.syncContainer(container, previousContainer?.State);
    }

    await this.cleanupStaleRecords(containers);

    return containers;
  }

  async watchContainers(): Promise<void> {
    logger.info("Starting container and tunnel monitoring (event-driven)");

    // Initial pass with an empty "previous" snapshot: any managed container
    // that's already running gets treated as a fresh transition, so labels
    // added before tunneldock started are picked up without a restart.
    let containers = await this.runReconciliationPass([]);

    // A pass can take several seconds (each Cloudflare call is a network
    // round trip). If an event arrives while one is already running, it must
    // still cause a follow-up pass once the current one finishes -- dropping
    // it would miss whatever changed in between (reproduced live: a "start"
    // event arriving mid-cleanup from a prior "stop" was silently lost).
    let isRunning = false;
    let rerunRequested = false;
    const triggerPass = async () => {
      rerunRequested = true;
      if (isRunning) return;
      isRunning = true;
      try {
        while (rerunRequested) {
          rerunRequested = false;
          await new Promise((resolve) => setTimeout(resolve, 250)); // debounce window to coalesce bursts
          try {
            containers = await this.runReconciliationPass(containers);
          } catch (error) {
            logger.error({ err: error }, "Error in event-triggered reconciliation pass");
          }
        }
      } finally {
        isRunning = false;
      }
    };

    await this.dockerService.subscribeToEvents((containerId, action) => {
      logger.debug({ containerId, action }, "Docker event received");
      void triggerPass();
    });

    // Fallback safety net in case the event stream ever drops or misses
    // something -- not the primary detection path anymore, just a backstop.
    setInterval(() => void triggerPass(), this.watchInterval);
  }

  async initialize(): Promise<void> {
    try {
      logger.info("Initializing TunnelDock...");
      await this.cloudflareService.initialize();
      // Initialize DockerService with domain after CloudflareService is initialized
      this.dockerService = new DockerService(
        this.cloudflareService.getDomain()
      );
      logger.info("TunnelDock initialization complete");
    } catch (error) {
      logger.error({ err: error }, "Failed to initialize TunnelDock");
      throw error;
    }
  }
}

// Start the application
const tunnelDock = new TunnelDock();
tunnelDock
  .initialize()
  .then(() => tunnelDock.watchContainers())
  .catch((error) => {
    logger.error({ err: error }, "Failed to start TunnelDock");
    process.exit(1);
  });
