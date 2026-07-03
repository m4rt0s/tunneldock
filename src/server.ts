import { DataService } from "./services/data";
import { CloudflareService } from "./services/cloudflare";
import { getRecentLogs } from "./utils/logger";
import { logger } from "./utils/logger";

interface ServerDeps {
  dataService: DataService;
  cloudflareService: CloudflareService;
  startedAt: string;
  deleteGracePeriodMs: number;
}

export function startDashboard(port: number, deps: ServerDeps): void {
  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/state") {
        const data = deps.dataService.loadData();
        return Response.json({
          timestamp: data.timestamp,
          startedAt: deps.startedAt,
          deleteGracePeriodMs: deps.deleteGracePeriodMs,
          status: deps.cloudflareService.getStatus(),
          tunnels: data.tunnels,
          domains: data.domains,
          containers: data.containers,
        });
      }

      if (url.pathname === "/api/logs") {
        return Response.json(getRecentLogs());
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(DASHBOARD_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  logger.info({ port }, "Dashboard listening");
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TunnelDock</title>
<style>
  :root {
    --bg: #14161a; --panel: #1c1f26; --border: #2a2e37; --text: #e4e6eb;
    --muted: #8b909c; --accent: #5b8def; --ok: #3fb950; --warn: #d29922; --err: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
  }
  h1 { font-size: 18px; font-weight: 500; margin: 0 0 4px; }
  h2 { font-size: 14px; font-weight: 500; margin: 0 0 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .sub { color: var(--muted); margin-bottom: 20px; }
  .status-bar {
    display: flex; flex-wrap: wrap; gap: 20px; background: var(--panel);
    border: 1px solid var(--border); border-radius: 8px; padding: 14px 18px; margin-bottom: 24px;
  }
  .status-item { display: flex; flex-direction: column; gap: 2px; }
  .status-item .label { color: var(--muted); font-size: 11px; text-transform: uppercase; }
  .status-item .value { font-size: 14px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  .badge.ok { background: rgba(63,185,80,0.15); color: var(--ok); }
  .badge.warn { background: rgba(210,153,34,0.15); color: var(--warn); }
  .badge.muted { background: rgba(139,144,156,0.15); color: var(--muted); }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 18px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; }
  tr:last-child td { border-bottom: none; }
  code { background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .empty { color: var(--muted); padding: 12px 0; }
  #logs { max-height: 360px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; }
  .log-line { white-space: pre-wrap; word-break: break-word; }
  .log-info { color: var(--text); }
  .log-warn { color: var(--warn); }
  .log-error { color: var(--err); }
  .log-debug { color: var(--muted); }
  .log-time { color: var(--muted); margin-right: 8px; }
</style>
</head>
<body>
  <h1>TunnelDock</h1>
  <div class="sub">Cloudflare Tunnel automático por labels de Docker</div>

  <div class="status-bar" id="status-bar"></div>

  <section>
    <h2>Rutas gestionadas</h2>
    <div id="tunnels-table"></div>
  </section>

  <section>
    <h2>Contenedores vistos</h2>
    <div id="containers-table"></div>
  </section>

  <section>
    <h2>Logs recientes</h2>
    <div id="logs"></div>
  </section>

<script>
function timeAgo(iso) {
  if (!iso) return '-';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function refreshState() {
  const res = await fetch('/api/state');
  const data = await res.json();

  const s = data.status;
  document.getElementById('status-bar').innerHTML = \`
    <div class="status-item"><span class="label">Cuenta</span><span class="value">\${esc(s.accountName)}</span></div>
    <div class="status-item"><span class="label">Zona</span><span class="value">\${esc(s.zoneName)}</span></div>
    <div class="status-item"><span class="label">Tunnel</span><span class="value">\${esc(s.tunnelName)}</span></div>
    <div class="status-item"><span class="label">Auth</span><span class="value"><span class="badge \${s.authMode === 'token' ? 'ok' : 'warn'}">\${s.authMode === 'token' ? 'API Token' : 'Global Key'}</span></span></div>
    <div class="status-item"><span class="label">En marcha desde</span><span class="value">hace \${timeAgo(data.startedAt)}</span></div>
    <div class="status-item"><span class="label">Última pasada</span><span class="value">hace \${timeAgo(data.timestamp)}</span></div>
  \`;

  const tunnelEntries = Object.entries(data.tunnels || {});
  const tunnelsHtml = tunnelEntries.length === 0
    ? '<div class="empty">Ninguna ruta gestionada todavía</div>'
    : \`<table><thead><tr><th>Hostname</th><th>Servicio</th><th>DNS</th><th>Config</th><th>Última sync</th><th>Estado</th></tr></thead><tbody>
        \${tunnelEntries.map(([hostname, t]) => {
          let stateBadge = '<span class="badge ok">activa</span>';
          if (t.staleSince) {
            const elapsed = Date.now() - new Date(t.staleSince).getTime();
            const remainingMs = Math.max(0, data.deleteGracePeriodMs - elapsed);
            const remainingMin = Math.ceil(remainingMs / 60000);
            stateBadge = \`<span class="badge warn">se borra en ~\${remainingMin}m</span>\`;
          }
          return \`<tr>
            <td><code>\${esc(hostname)}</code></td>
            <td><code>\${esc(t.service)}</code></td>
            <td>\${esc(t.dnsStatus || '-')}</td>
            <td>\${esc(t.configStatus || '-')}</td>
            <td>hace \${timeAgo(t.lastSync)}</td>
            <td>\${stateBadge}</td>
          </tr>\`;
        }).join('')}
      </tbody></table>\`;
  document.getElementById('tunnels-table').innerHTML = tunnelsHtml;

  const containers = (data.containers || []).slice().sort((a, b) => {
    const an = a.Labels && a.Labels['tunneldock.assign'] === 'true';
    const bn = b.Labels && b.Labels['tunneldock.assign'] === 'true';
    return (bn ? 1 : 0) - (an ? 1 : 0);
  });
  const containersHtml = containers.length === 0
    ? '<div class="empty">No hay contenedores</div>'
    : \`<table><thead><tr><th>Nombre</th><th>Estado</th><th>Gestionado</th><th>Hostname</th></tr></thead><tbody>
        \${containers.map(c => {
          const name = (c.Names && c.Names[0] || '').replace(/^\\//, '');
          const managed = c.Labels && c.Labels['tunneldock.assign'] === 'true';
          const hostname = managed ? (c.Labels['tunneldock.hostname'] || '-') : '-';
          const stateBadge = c.State === 'running' ? '<span class="badge ok">running</span>' : \`<span class="badge muted">\${esc(c.State)}</span>\`;
          return \`<tr>
            <td>\${esc(name)}</td>
            <td>\${stateBadge}</td>
            <td>\${managed ? '<span class="badge ok">sí</span>' : '<span class="badge muted">no</span>'}</td>
            <td>\${esc(hostname)}</td>
          </tr>\`;
        }).join('')}
      </tbody></table>\`;
  document.getElementById('containers-table').innerHTML = containersHtml;
}

async function refreshLogs() {
  const res = await fetch('/api/logs');
  const logs = await res.json();
  const el = document.getElementById('logs');
  const wasAtTop = el.scrollTop < 10;
  el.innerHTML = logs.map(l => {
    const t = new Date(l.time).toLocaleTimeString('es-ES');
    const extra = Object.keys(l).filter(k => !['time','level','msg'].includes(k))
      .map(k => \`\${k}=\${typeof l[k] === 'object' ? JSON.stringify(l[k]) : l[k]}\`).join(' ');
    return \`<div class="log-line log-\${l.level}"><span class="log-time">\${t}</span>\${esc(l.msg)}\${extra ? ' <span style="color:var(--muted)">' + esc(extra) + '</span>' : ''}</div>\`;
  }).join('');
  if (wasAtTop) el.scrollTop = 0;
}

function refresh() {
  refreshState().catch(console.error);
  refreshLogs().catch(console.error);
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
