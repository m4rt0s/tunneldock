import { DataService } from "./services/data";
import { CloudflareService } from "./services/cloudflare";
import { getRecentLogs } from "./utils/logger";
import { logger } from "./utils/logger";

interface ServerDeps {
  dataService: DataService;
  cloudflareService: CloudflareService;
  tunnelId: string;
  startedAt: string;
  deleteGracePeriodMs: number;
}

// Ingress rules and Access protection come from live Cloudflare API calls
// (several requests each), which is too slow/wasteful to redo on every
// dashboard poll (every 3s). Cache briefly instead.
const CLOUDFLARE_CACHE_TTL_MS = 20_000;
let cloudflareCache: {
  at: number;
  ingressRules: Array<{ hostname: string; service: string }>;
  accessProtection: Record<string, { appName: string; policies: string[] }>;
} | null = null;

async function getCloudflareState(cloudflareService: CloudflareService) {
  if (cloudflareCache && Date.now() - cloudflareCache.at < CLOUDFLARE_CACHE_TTL_MS) {
    return cloudflareCache;
  }
  const [ingressRules, accessProtection] = await Promise.all([
    cloudflareService.getIngressRules(),
    cloudflareService.getAccessProtection().catch((err) => {
      logger.error({ err }, "Failed to fetch Access protection (missing token scope?)");
      return {};
    }),
  ]);
  cloudflareCache = { at: Date.now(), ingressRules, accessProtection };
  return cloudflareCache;
}

export function startDashboard(port: number, deps: ServerDeps): void {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/state") {
        const data = deps.dataService.loadData();
        const managedHostnames = new Set(Object.keys(data.tunnels));

        let ingressRules: Array<{ hostname: string; service: string }> = [];
        let accessProtection: Record<string, { appName: string; policies: string[] }> = {};
        try {
          const cf = await getCloudflareState(deps.cloudflareService);
          ingressRules = cf.ingressRules;
          accessProtection = cf.accessProtection;
        } catch (err) {
          logger.error({ err }, "Failed to fetch live Cloudflare tunnel state");
        }

        const unmanagedRoutes = ingressRules.filter(
          (rule) => !managedHostnames.has(rule.hostname)
        );

        return Response.json({
          timestamp: data.timestamp,
          startedAt: deps.startedAt,
          deleteGracePeriodMs: deps.deleteGracePeriodMs,
          status: deps.cloudflareService.getStatus(),
          tunnels: data.tunnels,
          unmanagedRoutes,
          accessProtection,
        });
      }

      if (url.pathname === "/api/logs") {
        return Response.json(getRecentLogs());
      }

      if (url.pathname === "/api/routes/delete" && req.method === "POST") {
        try {
          const { hostname } = (await req.json()) as { hostname?: string };
          if (!hostname) {
            return Response.json({ error: "hostname required" }, { status: 400 });
          }

          await deps.cloudflareService.deleteTunnelConfig(hostname, deps.tunnelId);

          const data = deps.dataService.loadData();
          if (data.tunnels[hostname]) {
            delete data.tunnels[hostname];
            if (data.domains[hostname]) delete data.domains[hostname];
            deps.dataService.saveData({ ...data, timestamp: new Date().toISOString() });
          }

          cloudflareCache = null; // force a fresh read on the next /api/state
          logger.info({ hostname }, "Route deleted manually via dashboard");
          return Response.json({ success: true });
        } catch (err) {
          logger.error({ err }, "Failed to manually delete route");
          return Response.json({ error: "delete failed" }, { status: 500 });
        }
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
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; white-space: nowrap; }
  .badge.ok { background: rgba(63,185,80,0.15); color: var(--ok); }
  .badge.warn { background: rgba(210,153,34,0.15); color: var(--warn); }
  .badge.muted { background: rgba(139,144,156,0.15); color: var(--muted); }
  .badge.accent { background: rgba(91,141,239,0.15); color: var(--accent); }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 18px; margin-bottom: 20px; }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 560px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  code { background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  a.hostname-link { color: var(--accent); text-decoration: none; }
  a.hostname-link:hover { text-decoration: underline; }
  .empty { color: var(--muted); padding: 12px 0; }
  .btn-delete {
    background: rgba(248,81,73,0.12); color: var(--err); border: 1px solid rgba(248,81,73,0.3);
    border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .btn-delete:hover { background: rgba(248,81,73,0.22); }
  .btn-delete:disabled { opacity: 0.5; cursor: default; }
  #logs { max-height: 360px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; }
  .log-line { white-space: pre-wrap; word-break: break-word; }
  .log-info { color: var(--text); }
  .log-warn { color: var(--warn); }
  .log-error { color: var(--err); }
  .log-debug { color: var(--muted); }
  .log-time { color: var(--muted); margin-right: 8px; }

  @media (max-width: 640px) {
    body { padding: 12px; font-size: 13px; }
    section { padding: 12px; border-radius: 6px; }
    .status-bar { gap: 12px 20px; padding: 12px; }
    th, td { padding: 6px 8px; font-size: 12px; }
    h1 { font-size: 16px; }
  }
</style>
</head>
<body>
  <h1>TunnelDock</h1>
  <div class="sub">Cloudflare Tunnel automático por labels de Docker</div>

  <div class="status-bar" id="status-bar"></div>

  <section>
    <h2>Rutas gestionadas</h2>
    <div class="table-scroll" id="tunnels-table"></div>
  </section>

  <section>
    <h2>Rutas no gestionadas</h2>
    <div class="table-scroll" id="unmanaged-table"></div>
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

function hostnameLink(hostname) {
  return \`<a class="hostname-link" href="https://\${esc(hostname)}" target="_blank" rel="noopener"><code>\${esc(hostname)}</code></a>\`;
}

function accessBadge(hostname, accessProtection) {
  const protection = accessProtection[hostname];
  if (!protection) return '<span class="badge muted">sin protección</span>';
  const names = protection.policies.length ? protection.policies.join(', ') : protection.appName;
  return \`<span class="badge accent" title="\${esc(protection.appName)}">\${esc(names)}</span>\`;
}

async function deleteRoute(hostname, btn) {
  if (!confirm(\`¿Borrar la ruta \${hostname}? Esto elimina el DNS y la regla de ingress en Cloudflare.\`)) return;
  btn.disabled = true;
  btn.textContent = 'Borrando...';
  try {
    const res = await fetch('/api/routes/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname }),
    });
    if (!res.ok) throw new Error('failed');
    await refreshState();
  } catch (e) {
    alert('No se pudo borrar la ruta. Revisa los logs.');
    btn.disabled = false;
    btn.textContent = 'Borrar';
  }
}
window.deleteRoute = deleteRoute;

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
    : \`<table><thead><tr><th>Hostname</th><th>Servicio</th><th>Access</th><th>DNS</th><th>Config</th><th>Última sync</th><th>Estado</th><th></th></tr></thead><tbody>
        \${tunnelEntries.map(([hostname, t]) => {
          let stateBadge = '<span class="badge ok">activa</span>';
          if (t.staleSince) {
            const elapsed = Date.now() - new Date(t.staleSince).getTime();
            const remainingMs = Math.max(0, data.deleteGracePeriodMs - elapsed);
            const remainingMin = Math.ceil(remainingMs / 60000);
            stateBadge = \`<span class="badge warn">se borra en ~\${remainingMin}m</span>\`;
          }
          return \`<tr>
            <td>\${hostnameLink(hostname)}</td>
            <td><code>\${esc(t.service)}</code></td>
            <td>\${accessBadge(hostname, data.accessProtection || {})}</td>
            <td>\${esc(t.dnsStatus || '-')}</td>
            <td>\${esc(t.configStatus || '-')}</td>
            <td>hace \${timeAgo(t.lastSync)}</td>
            <td>\${stateBadge}</td>
            <td><button class="btn-delete" onclick="deleteRoute('\${esc(hostname)}', this)">Borrar</button></td>
          </tr>\`;
        }).join('')}
      </tbody></table>\`;
  document.getElementById('tunnels-table').innerHTML = tunnelsHtml;

  const unmanaged = data.unmanagedRoutes || [];
  const unmanagedHtml = unmanaged.length === 0
    ? '<div class="empty">No hay rutas sin gestionar en el tunnel</div>'
    : \`<table><thead><tr><th>Hostname</th><th>Servicio</th><th>Access</th><th></th></tr></thead><tbody>
        \${unmanaged.map(r => \`<tr>
            <td>\${hostnameLink(r.hostname)}</td>
            <td><code>\${esc(r.service)}</code></td>
            <td>\${accessBadge(r.hostname, data.accessProtection || {})}</td>
            <td><button class="btn-delete" onclick="deleteRoute('\${esc(r.hostname)}', this)">Borrar</button></td>
          </tr>\`).join('')}
      </tbody></table>\`;
  document.getElementById('unmanaged-table').innerHTML = unmanagedHtml;
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
