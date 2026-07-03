# TunnelDock

> Fork of [radityaharya/tunneldock](https://github.com/radityaharya/tunneldock), vendored here because upstream has minimal commit history and no releases. See [Security note](#security-note) before deploying.

TunnelDock automatically manages Cloudflare Tunnel configurations for Docker containers. It monitors container state changes and configures Cloudflare Tunnels and DNS records accordingly.

## Features

- Automatic Cloudflare Tunnel configuration for Docker containers
- DNS record management via Cloudflare API
- Container state monitoring
- Configurable via Docker labels

## Prerequisites

- Docker and Docker Compose
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

2. Create a `.env` file with your Cloudflare credentials:
   ```env
   CF_API_TOKEN=your_api_token
   CF_API_EMAIL=your_email
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

`CF_API_TOKEN` here is **not** a scoped Cloudflare API Token. The Cloudflare service in this codebase only implements the legacy `X-Auth-Email` + `X-Auth-Key` (Global API Key) auth scheme — there is no way to run this with a permission-limited token. The Global API Key grants full access to the entire Cloudflare account (every zone, every tunnel, billing), not just the zone/tunnel you're configuring.

Combined with upstream's minimal review history, that's a real risk if this container is ever compromised. Two mitigations are baked into `docker-compose.yml`:

- **No direct Docker socket access.** `tunneldock` only ever calls `GET /containers/json` (see `src/services/docker.ts`). Instead of mounting `/var/run/docker.sock` into it, a [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy) sits in front with only `CONTAINERS=1` enabled — everything else (exec, create, start/stop, volumes...) is blocked by default. `tunneldock` talks to it over `DOCKER_HOST=tcp://docker-socket-proxy:2375`, dockerode picks that up automatically.
- **Isolate the Cloudflare account if you can.** If this account has other zones/tunnels you care about, consider a dedicated Cloudflare account for whatever this manages, so a compromised Global Key doesn't reach unrelated infrastructure.

If you want scoped-token auth instead, look at [DockFlare](https://github.com/ChrispyBacon-dev/DockFlare) — heavier (needs Redis) but actively maintained and uses real API Tokens.

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