# TunnelDock

> Fork of [radityaharya/tunneldock](https://github.com/radityaharya/tunneldock), vendored here because upstream has minimal commit history and no releases. See [Security note](#security-note) before deploying.

TunnelDock automatically manages Cloudflare Tunnel configurations for Docker containers. It listens to Docker's container events (`start`/`die`/`stop`/`destroy`) and configures Cloudflare Tunnels and DNS records accordingly.

## Features

- Automatic Cloudflare Tunnel configuration for Docker containers
- DNS record management via Cloudflare API
- Event-driven container monitoring, not polling (see below) -- with a long-interval fallback pass (`TUNNELDOCK_WATCH_INTERVAL`) in case the event stream ever drops something
- Grace period before deleting a route (`TUNNELDOCK_DELETE_GRACE_PERIOD_MS`, default 5min) -- stopping a container to redeploy or edit its config doesn't immediately tear down its DNS/ingress; it's only removed once it's stayed down longer than the grace period
- Configurable via Docker labels

### Why events, not polling

Upstream compared container-list snapshots on a fixed interval (default 1s). That misses a transition entirely if a container restarts faster than the interval -- reproduced here by restarting a container in under a second and watching tunneldock never notice. Docker's `/events` endpoint delivers every `start`/`die`/`stop` as a discrete event with no timing window to lose, so that's what `src/services/docker.ts`'s `subscribeToEvents()` uses instead. A reconciliation pass still runs on every event (debounced 250ms to coalesce bursts like a `docker compose up` restarting several containers at once), so the actual sync/cleanup logic is unchanged -- only what triggers it is different.

## Prerequisites

- Docker and Docker Compose
- **Your `cloudflared` container must be on the same Docker network as the containers TunnelDock will manage.** Generated ingress rules point at `http://<container-name>:<port>` (the origin is reached *from cloudflared's own container*, not from the host) -- upstream originally hardcoded `localhost`, which only works if cloudflared shares a network namespace with every service, and produces a 502 otherwise.
- A Cloudflare account with:
  - API token
  - Account ID
  - Zone ID
  - Cloudflare Tunnel already created

## Setup Instructions

1. Clone the repository:
   ```sh
   git clone https://github.com/yourusername/tunneldock.git
   cd tunneldock
   ```

2. Create a `.env` file with your Cloudflare credentials (see `env.example`):
   ```env
   # Preferred: a scoped API Token
   CF_API_TOKEN=your_scoped_api_token
   # Legacy fallback instead of CF_API_TOKEN -- see "Security note"
   # CF_API_KEY=your_global_api_key
   # CF_API_EMAIL=your_email
   CF_ACCOUNT_ID=your_account_id
   CF_ZONE_ID=your_zone_id
   CF_TUNNEL_ID=your_tunnel_id
   # Optional configurations
   TUNNELDOCK_WATCH_INTERVAL=1000
   LOG_LEVEL=info
   ```

3. Start TunnelDock using Docker Compose:
   ```sh
   docker compose up -d
   ```

That's it! TunnelDock will now monitor your Docker containers and manage Cloudflare Tunnel configurations automatically. The bundled `docker-compose.yml` pulls the prebuilt image from `ghcr.io/m4rt0s/tunneldock:latest` (published by the GitHub Actions workflow on every push to `main`) and never mounts the real Docker socket into the tunneldock container — see below.

## Security note

Set `CF_API_TOKEN` to a scoped Cloudflare API Token with only:
- `Account.Cloudflare Tunnel:Edit`
- `Zone.DNS:Edit`
- `Zone.Zone:Read`
- `Account.Account Settings:Read`

That's the minimum this app actually needs (see `src/services/cloudflare.ts`) — nothing else on your account is reachable even if the container is compromised.

`CF_API_KEY` + `CF_API_EMAIL` (the legacy Global API Key) is still supported as a fallback if `CF_API_TOKEN` is unset, but it grants full access to the entire Cloudflare account (every zone, every tunnel, billing) — only use it if your Cloudflare plan/token type genuinely can't cover the calls above with a scoped token.

Regardless of which auth mode you use, `docker-compose.yml` also isolates Docker socket access:

- **No direct Docker socket access.** `tunneldock` only ever calls `GET /containers/json` and `GET /events` (see `src/services/docker.ts`). Instead of mounting `/var/run/docker.sock` into it, a [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) sits in front with only `CONTAINERS=1` and `EVENTS=1` enabled — everything else (exec, create, start/stop, volumes...) is blocked by default. `tunneldock` talks to it over `DOCKER_HOST=tcp://docker-socket-proxy:2375`, dockerode picks that up automatically.
- **If you must use the legacy Global API Key**, consider a dedicated Cloudflare account for whatever this manages, so a compromised key doesn't reach unrelated infrastructure.

## Environment Variables

Required:
- `CF_API_TOKEN`: Your Cloudflare API token
- `CF_API_EMAIL`: Your Cloudflare account email
- `CF_ACCOUNT_ID`: Your Cloudflare account ID
- `CF_ZONE_ID`: Your Cloudflare zone ID
- `CF_TUNNEL_ID`: Your Cloudflare Tunnel ID

Optional:
- `TUNNELDOCK_WATCH_INTERVAL`: Container watch interval in milliseconds (default: 1000)
- `LOG_LEVEL`: Log level (default: 'info')

## Configuration

TunnelDock is configured via Docker labels. The following labels are supported:

- `tunneldock.assign`: Set to `true` to enable TunnelDock for the container
- `tunneldock.hostname`: The hostname for the DNS record (default: `containerName.CF_DOMAIN`)
- `tunneldock.service.protocol`: Protocol for the service (default: 'http')
- `tunneldock.service.port`: Port number for the service (default: first public port or 80)
- `tunneldock.service.path`: Path to append to the service URL (optional)
- `tunneldock.originRequest`: Configure tunnel origin request settings
  - `tunneldock.originRequest.http2Origin`: Enable/disable HTTP/2 (boolean)
  - `tunneldock.originRequest.noTLSVerify`: Disable TLS verification (boolean)
  - `tunneldock.originRequest.disableChunkedEncoding`: Disable chunked encoding (boolean)
  - `tunneldock.originRequest.noHappyEyeballs`: Disable Happy Eyeballs (boolean)
  - `tunneldock.originRequest.connectTimeout`: Connection timeout in seconds (number)
  - `tunneldock.originRequest.keepAliveConnections`: Keep-alive connections (number)
  - `tunneldock.originRequest.keepAliveTimeout`: Keep-alive timeout in seconds (number)
  - `tunneldock.originRequest.tcpKeepAlive`: TCP keep-alive in seconds (number)
  - `tunneldock.originRequest.tlsTimeout`: TLS timeout in seconds (number)
  - `tunneldock.originRequest.httpHostHeader`: Custom host header
  - `tunneldock.originRequest.originServerName`: Origin server name
  - `tunneldock.originRequest.proxyType`: Proxy type (empty for regular proxy, "socks" for SOCKS5)

Example container labels:
```yaml
labels:
  tunneldock.assign: "true"
  tunneldock.hostname: "myapp"
  tunneldock.service.protocol: "http"
  tunneldock.service.port: "8080"
  tunneldock.service.path: "/api"
  tunneldock.originRequest.http2Origin: "true"
  tunneldock.originRequest.noTLSVerify: "false"
  tunneldock.originRequest.tcpKeepAlive: "30"
```