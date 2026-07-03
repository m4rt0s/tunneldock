import { default as Cloudflare } from "cloudflare";
import { TunnelConfig } from "../types";
import { logger } from "../utils/logger";

// The SDK's Ingress type marks `hostname` as required, but the real
// Cloudflare API omits it entirely for the catch-all rule (verified
// directly against the API) -- the cast documents that one known gap.
const CATCH_ALL_RULE = { service: "http_status:404" } as any;

export class CloudflareService {
  private cloudflare: Cloudflare;
  private accountId: string;
  private zoneId: string;
  private domain: string;
  private accountName: string = "";
  private tunnelName: string = "";
  private authMode: "token" | "legacy-key";

  constructor() {
    // Two auth modes, in priority order:
    //   1. CF_API_TOKEN: a real scoped Bearer token (Zone:DNS:Edit +
    //      Account:Cloudflare Tunnel:Edit + Account Settings:Read + Zone:Read).
    //      Preferred -- limited to exactly what this app touches.
    //   2. CF_API_KEY + CF_API_EMAIL: the legacy Global API Key, which grants
    //      full account access. Only used if no CF_API_TOKEN is set. See
    //      README "Security note" for why this is best avoided.
    if (process.env.CF_API_TOKEN) {
      logger.info("Using scoped Cloudflare API Token for authentication");
      this.authMode = "token";
      this.cloudflare = new Cloudflare({
        apiToken: process.env.CF_API_TOKEN,
      });
    } else if (process.env.CF_API_KEY && process.env.CF_API_EMAIL) {
      logger.warn(
        "Using legacy Global API Key -- this grants full Cloudflare account " +
          "access, not just this zone/tunnel. Prefer CF_API_TOKEN if possible."
      );
      this.authMode = "legacy-key";
      this.cloudflare = new Cloudflare({
        apiEmail: process.env.CF_API_EMAIL,
        apiKey: process.env.CF_API_KEY,
      });
    } else {
      throw new Error(
        "No Cloudflare credentials configured: set either CF_API_TOKEN " +
          "(preferred) or both CF_API_KEY and CF_API_EMAIL"
      );
    }
    this.accountId = process.env.CF_ACCOUNT_ID || "";
    this.zoneId = process.env.CF_ZONE_ID || "";
    this.domain = "";
  }

  async initialize(): Promise<void> {
    try {
      logger.info("Starting Cloudflare service initialization...");

      logger.debug("Validating account credentials...");
      // Validate credentials
      const account = await this.cloudflare.accounts.get({
        account_id: this.accountId,
      });
      if (!account) {
        throw new Error("Invalid Cloudflare account credentials");
      }
      this.accountName = account.name;
      logger.debug("Account credentials validated successfully");

      // Get zone details
      logger.debug("Fetching zone details...");
      const zone = await this.cloudflare.zones.get({
        zone_id: this.zoneId,
      });
      if (!zone) {
        throw new Error("Invalid zone ID");
      }
      this.domain = zone.name;
      logger.debug(
        { zoneName: zone.name },
        "Zone details fetched successfully"
      );

      // Verify tunnel exists
      logger.debug("Verifying tunnel...");
      const tunnel = await this.cloudflare.zeroTrust.tunnels.get(
        process.env.CF_TUNNEL_ID || "",
        { account_id: this.accountId }
      );
      if (!tunnel) {
        throw new Error("Invalid tunnel ID");
      }
      this.tunnelName = tunnel.name || "";
      logger.debug("Tunnel verified successfully");

      logger.info(
        {
          account: account.name,
          zone: zone.name,
          tunnel: tunnel.name,
        },
        "Cloudflare service initialized successfully"
      );
    } catch (error: any) {
      logger.error({ err: error }, "Failed to initialize Cloudflare service");
      throw new Error(`Cloudflare initialization failed: ${error.message}`);
    }
  }

  getDomain(): string {
    return this.domain;
  }

  getStatus() {
    return {
      accountName: this.accountName,
      zoneName: this.domain,
      tunnelName: this.tunnelName,
      tunnelId: this.tunnelId(),
      authMode: this.authMode,
    };
  }

  private tunnelId(): string {
    return process.env.CF_TUNNEL_ID || "";
  }

  // All ingress rules currently on the tunnel, straight from Cloudflare --
  // includes routes tunneldock never created (manually configured ones),
  // which is the point: this is used to show what's *actually* live, not
  // just what's in our own local tracking file.
  async getIngressRules(): Promise<Array<{ hostname: string; service: string }>> {
    const currentConfig = await this.cloudflare.zeroTrust.tunnels.configurations.get(
      this.tunnelId(),
      { account_id: this.accountId }
    );
    const rules = currentConfig.config?.ingress || [];
    return rules
      .filter((rule) => rule.hostname)
      .map((rule) => ({ hostname: rule.hostname!, service: rule.service }));
  }

  // Maps hostname -> Access application name + policy names, for every
  // Access Application whose domain matches one of our routes. A route with
  // no entry here has no Access protection at all.
  async getAccessProtection(): Promise<Record<string, { appName: string; policies: string[] }>> {
    const result: Record<string, { appName: string; policies: string[] }> = {};

    const apps = await this.cloudflare.zeroTrust.access.applications.list({
      account_id: this.accountId,
    });

    // One policies.list() call per app -- run them concurrently instead of
    // sequentially. Same total request count (still counts against the rate
    // limit the same), but doesn't serialize their latency one after another.
    await Promise.all(
      (apps.result ?? []).map(async (app) => {
        const domain = (app as { domain?: string }).domain;
        const appId = (app as { id?: string }).id;
        const appName = (app as { name?: string }).name || "Access";
        if (!domain || !appId) return;

        // domain can include a path (e.g. "host.example.com/admin"); we only
        // route by hostname, so match on that part.
        const hostname = domain.split("/")[0];

        const policies = await this.cloudflare.zeroTrust.access.applications.policies.list(
          appId,
          { account_id: this.accountId }
        );
        const policyNames = (policies.result ?? [])
          .map((p) => (p as { name?: string }).name)
          .filter((name): name is string => !!name);

        result[hostname] = { appName, policies: policyNames };
      })
    );

    return result;
  }

  // Looks up an existing *reusable* Access policy by name (the account-level
  // kind shared across applications, like "Yo y familia" or "service token
  // only" -- not a one-off policy scoped to a single app). tunneldock only
  // ever attaches to policies that already exist; it never creates them,
  // since policy rules (who/what they allow) are a security decision that
  // shouldn't be inferred from a label value.
  private async findReusablePolicyId(policyName: string): Promise<string | null> {
    const policies = await this.cloudflare.zeroTrust.access.policies.list({
      account_id: this.accountId,
    });
    const match = (policies.result ?? []).find(
      (p) => (p as { name?: string }).name?.toLowerCase() === policyName.toLowerCase()
    );
    return (match as { id?: string } | undefined)?.id ?? null;
  }

  // Creates or updates the Access Application for `hostname` so it's
  // protected by the named reusable policy. Returns the Application ID to
  // persist locally (so a later label removal knows it's safe to delete
  // *this* app), or null if the named policy doesn't exist -- in which case
  // nothing is touched.
  async ensureAccessApplication(
    hostname: string,
    policyName: string,
    existingAppId?: string
  ): Promise<string | null> {
    const policyId = await this.findReusablePolicyId(policyName);
    if (!policyId) {
      logger.error(
        { hostname, policyName },
        "No reusable Access policy with this name exists -- skipping Access setup"
      );
      return null;
    }

    const appParams = {
      account_id: this.accountId,
      domain: hostname,
      type: "self_hosted",
      name: hostname,
      policies: [policyId],
    };

    if (existingAppId) {
      await this.cloudflare.zeroTrust.access.applications.update(existingAppId, appParams as any);
      logger.info({ hostname, policyName, appId: existingAppId }, "Updated Access application");
      return existingAppId;
    }

    const created = await this.cloudflare.zeroTrust.access.applications.create(appParams as any);
    const appId = (created as { id?: string }).id ?? null;
    logger.info({ hostname, policyName, appId }, "Created Access application");
    return appId;
  }

  // Deletes an Access Application tunneldock itself created (identified by
  // the ID tracked locally) -- never looked up by hostname here, precisely
  // so this can't accidentally reach an Access app someone else configured
  // manually for the same domain.
  async removeAccessApplication(appId: string): Promise<void> {
    await this.cloudflare.zeroTrust.access.applications.delete(appId, {
      account_id: this.accountId,
    });
    logger.info({ appId }, "Removed Access application");
  }

  async manageDNSRecord(hostname: string, tunnelId: string): Promise<string> {
    try {
      logger.info({ hostname }, `Managing DNS record`);
      const subdomain = hostname.split(".")[0];
      const target = `${tunnelId}.cfargotunnel.com`;

      const records = await this.cloudflare.dns.records.list({
        zone_id: this.zoneId,
        name: {
          exact: hostname,
        },
        type: "CNAME",
      });

      let status = "";
      if (records.result && records.result.length > 0) {
        const existingRecord = records.result[0];
        if (existingRecord.content !== target) {
          logger.info({ hostname, target }, `Updating existing record`);
          await this.cloudflare.dns.records.update(existingRecord.id, {
            zone_id: this.zoneId,
            content: target,
            name: subdomain,
            type: "CNAME",
            proxied: true,
          });
          status = "updated";
          logger.info({ hostname }, `Successfully updated DNS record`);
        } else {
          status = "unchanged";
          logger.info(
            { hostname },
            `No changes needed, record already correct`
          );
        }
      } else {
        logger.info({ hostname, target }, `Creating new record`);
        await this.cloudflare.dns.records.create({
          zone_id: this.zoneId,
          content: target,
          name: subdomain,
          type: "CNAME",
          proxied: true,
        });
        status = "created";
        logger.info({ hostname }, `Successfully created DNS record`);
      }

      return status;
    } catch (error) {
      logger.error({ err: error, hostname }, `Error managing DNS record`);
      throw error;
    }
  }

  async updateTunnelConfig(
    tunnelId: string,
    config: TunnelConfig
  ): Promise<void> {
    try {
      logger.info({ tunnelId, config }, `Updating tunnel configuration`);

      const currentConfig =
        await this.cloudflare.zeroTrust.tunnels.configurations.get(tunnelId, {
          account_id: this.accountId,
        });

      const defaultOriginRequest = {
        connectTimeout: 0,
        disableChunkedEncoding: false,
        http2Origin: false,
        noTLSVerify: false,
        tcpKeepAlive: 30,
      };

      // Get current ingress rules or initialize with default catch-all.
      // No `hostname` field -- see the note in deleteTunnelConfig. The cast
      // is needed because the SDK's Ingress type marks `hostname` as
      // required even though the real API omits it for the catch-all rule
      // (verified directly against the API).
      let ingressRules = currentConfig.config?.ingress || [
        CATCH_ALL_RULE,
      ];

      // Find if there's an existing rule for this hostname
      const existingRuleIndex = ingressRules.findIndex(
        (rule) => rule.hostname === config.hostname
      );

      const newRule = {
        hostname: config.hostname,
        service: config.service,
        originRequest: {
          ...defaultOriginRequest,
          ...config.originRequest,
        },
      };

      if (existingRuleIndex !== -1) {
        // Update existing rule
        ingressRules[existingRuleIndex] = newRule;
      } else {
        // Add new rule before the catch-all rule
        ingressRules.splice(ingressRules.length - 1, 0, newRule);
      }

      const tunnelConfig = {
        account_id: this.accountId,
        config: {
          ingress: ingressRules,
        },
      };

      logger.debug(
        { tunnelConfig },
        "Sending tunnel configuration to Cloudflare"
      );

      await this.cloudflare.zeroTrust.tunnels.configurations.update(
        tunnelId,
        tunnelConfig
      );

      logger.info(
        { tunnelId, hostname: config.hostname },
        `Successfully updated tunnel configuration`
      );
    } catch (error) {
      logger.error(
        { err: error, tunnelId, config },
        `Error updating tunnel configuration`
      );
      throw error;
    }
  }

  async deleteTunnelConfig(
    hostname: string,
    tunnelId: string,
    accessAppId?: string
  ): Promise<void> {
    try {
      logger.info({ hostname, tunnelId }, "Deleting tunnel configuration");

      if (accessAppId) {
        await this.removeAccessApplication(accessAppId);
      }

      // First, find and remove the DNS record
      const records = await this.cloudflare.dns.records.list({
        zone_id: this.zoneId,
        name: {
          exact: hostname,
        },
        type: "CNAME",
      });
      if (records.result && records.result.length > 0) {
        const record = records.result[0];
        await this.cloudflare.dns.records.delete(record.id, {
          zone_id: this.zoneId,
        });
        logger.debug({ hostname }, "DNS record deleted");
      } else {
        logger.debug({ hostname }, "No DNS record found to delete");
      }

      // Then remove the tunnel ingress configuration
      const currentConfig =
        await this.cloudflare.zeroTrust.tunnels.configurations.get(tunnelId, {
          account_id: this.accountId,
        });

      let ingressRules = currentConfig.config?.ingress || [];

      // Filter out the rule for this hostname
      ingressRules = ingressRules.filter((rule) => rule.hostname !== hostname);

      // Cloudflare's catch-all rule omits `hostname` entirely -- it is never
      // the literal string "*". Comparing against "*" here never matches the
      // real catch-all, so this used to append a *second* one after it,
      // producing an invalid config (a non-terminal rule with an empty
      // hostname) that Cloudflare rejects with a 400 on every cleanup.
      const hasCatchAll = ingressRules.some((rule) => !rule.hostname);
      if (!hasCatchAll) {
        ingressRules.push(CATCH_ALL_RULE);
      }

      const tunnelConfig = {
        account_id: this.accountId,
        config: {
          ingress: ingressRules,
        },
      };

      await this.cloudflare.zeroTrust.tunnels.configurations.update(
        tunnelId,
        tunnelConfig
      );

      logger.info(
        { hostname, tunnelId },
        "Successfully deleted tunnel configuration and DNS record"
      );
    } catch (error) {
      logger.error(
        { err: error, hostname, tunnelId },
        "Error deleting tunnel configuration"
      );
      throw error;
    }
  }
}
