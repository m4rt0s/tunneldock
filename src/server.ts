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
// (several requests each). Stale-while-revalidate: once we have any cached
// value, always answer instantly with it and refresh in the background --
// never block a page load on Cloudflare's latency just because the 20s TTL
// expired. Only the very first fetch after startup (no cache yet) has to
// wait, and the manual refresh button can force a real wait when the user
// explicitly wants to know the fetch actually happened.
const CLOUDFLARE_CACHE_TTL_MS = 20_000;
type ReusablePolicy = {
  id: string;
  name: string;
  decision: string;
  sessionDuration: string;
  appCount: number;
  summary: string;
};
type DnsRecord = { type: string; name: string; content: string; proxied: boolean; ttl: number };
type CloudflareState = {
  at: number;
  ingressRules: Array<{ hostname: string; service: string }>;
  accessProtection: Record<string, { appName: string; policies: string[] }>;
  reusablePolicies: ReusablePolicy[];
  dnsRecords: DnsRecord[];
};
let cloudflareCache: CloudflareState | null = null;
// De-dupes concurrent fetches: without this, an in-flight fetch that started
// *before* a delete (and so still sees the old, undeleted route) can finish
// *after* the delete's own cache invalidation and overwrite it with stale
// data -- reproduced live as a route lingering in the UI well past its
// actual deletion. Every caller while a fetch is running awaits the same
// promise instead of racing their own.
let inFlightFetch: Promise<CloudflareState> | null = null;

function fetchFreshCloudflareState(cloudflareService: CloudflareService): Promise<CloudflareState> {
  if (inFlightFetch) return inFlightFetch;
  inFlightFetch = (async () => {
    const [ingressRules, accessProtection, reusablePolicies, dnsRecords] = await Promise.all([
      cloudflareService.getIngressRules(),
      cloudflareService.getAccessProtection().catch((err) => {
        logger.error({ err }, "Failed to fetch Access protection (missing token scope?)");
        return {};
      }),
      cloudflareService.getReusablePolicies().catch((err) => {
        logger.error({ err }, "Failed to fetch reusable Access policies");
        return [];
      }),
      cloudflareService.getAllDnsRecords().catch((err) => {
        logger.error({ err }, "Failed to fetch DNS records");
        return [];
      }),
    ]);
    const state = { at: Date.now(), ingressRules, accessProtection, reusablePolicies, dnsRecords };
    cloudflareCache = state;
    return state;
  })();
  inFlightFetch.finally(() => {
    inFlightFetch = null;
  });
  return inFlightFetch;
}

async function getCloudflareState(cloudflareService: CloudflareService, forceFresh: boolean) {
  if (forceFresh) {
    return fetchFreshCloudflareState(cloudflareService);
  }

  const isFresh = cloudflareCache && Date.now() - cloudflareCache.at < CLOUDFLARE_CACHE_TTL_MS;
  if (isFresh) {
    return cloudflareCache!;
  }

  if (cloudflareCache) {
    // Stale but present: serve it now, let the refresh happen quietly.
    fetchFreshCloudflareState(cloudflareService).catch(() => {});
    return cloudflareCache;
  }

  // Nothing cached yet (first call since startup) -- no choice but to wait.
  return fetchFreshCloudflareState(cloudflareService);
}

export function startDashboard(port: number, deps: ServerDeps): void {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/state") {
        const data = deps.dataService.loadData();

        const response: Record<string, unknown> = {
          timestamp: data.timestamp,
          startedAt: deps.startedAt,
          deleteGracePeriodMs: deps.deleteGracePeriodMs,
          status: deps.cloudflareService.getStatus(), // local fields, no API call
          tunnels: data.tunnels,
        };

        // unmanagedRoutes/accessProtection cost ~8 Cloudflare API calls each
        // (1 for ingress + 1 to list Access apps + 1 per app for its
        // policies). Cloudflare's account-wide limit is 1200 req/5min,
        // shared with cloudflared and everything else on this account --
        // only fetch this on demand (page load / manual refresh), never on
        // the automatic polling tick.
        if (url.searchParams.has("live")) {
          const managedHostnames = new Set(Object.keys(data.tunnels));
          try {
            const cf = await getCloudflareState(deps.cloudflareService, url.searchParams.has("fresh"));
            response.unmanagedRoutes = cf.ingressRules.filter(
              (rule) => !managedHostnames.has(rule.hostname)
            );
            response.accessProtection = cf.accessProtection;
            response.reusablePolicies = cf.reusablePolicies;
            response.dnsRecords = cf.dnsRecords;
          } catch (err) {
            logger.error({ err }, "Failed to fetch live Cloudflare tunnel state");
          }
        }

        return Response.json(response);
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

          const data = deps.dataService.loadData();
          await deps.cloudflareService.deleteTunnelConfig(
            hostname,
            deps.tunnelId,
            data.tunnels[hostname]?.accessAppId
          );

          if (data.tunnels[hostname]) {
            delete data.tunnels[hostname];
            if (data.domains[hostname]) delete data.domains[hostname];
            deps.dataService.saveData({ ...data, timestamp: new Date().toISOString() });
          }

          logger.info({ hostname }, "Route deleted manually via dashboard");
          return Response.json({ success: true });
        } catch (err) {
          logger.error({ err }, "Failed to manually delete route");
          const message = err instanceof Error ? err.message : "delete failed";
          return Response.json({ error: message }, { status: 500 });
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
  .sub { color: var(--muted); }
  .header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
  .btn-refresh {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 14px; font-size: 13px; cursor: pointer; white-space: nowrap;
  }
  .btn-refresh:hover { border-color: var(--accent); color: var(--accent); }
  .btn-refresh:disabled { opacity: 0.6; cursor: default; }

  .tabs {
    display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .tab-btn {
    background: none; border: none; color: var(--muted); padding: 10px 16px;
    font-size: 13px; cursor: pointer; white-space: nowrap; border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab-btn:hover { color: var(--text); }
  .tab-btn.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 500; }

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
    border-radius: 6px; padding: 5px 7px; cursor: pointer; display: inline-flex; align-items: center;
  }
  .btn-delete:hover { background: rgba(248,81,73,0.22); }
  .btn-delete:disabled { opacity: 0.6; cursor: default; }
  .btn-delete svg { display: block; }
  tr.row-deleting { opacity: 0.45; transition: opacity 0.2s; }

  #toast-container {
    position: fixed; top: 16px; right: 16px; z-index: 1000;
    display: flex; flex-direction: column; gap: 8px; max-width: min(360px, calc(100vw - 32px));
  }
  .toast {
    padding: 12px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    animation: toast-in 0.2s ease-out;
  }
  .toast.success { background: #1a3d24; color: var(--ok); border: 1px solid rgba(63,185,80,0.4); }
  .toast.error { background: #3d1f1e; color: var(--err); border: 1px solid rgba(248,81,73,0.4); }
  @keyframes toast-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }

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
    th, td { padding: 6px 8px; font-size: 12px; }
    h1 { font-size: 16px; }
    #toast-container { left: 12px; right: 12px; top: 12px; max-width: none; }
  }
</style>
</head>
<body>
  <div id="toast-container"></div>

  <div class="header-row">
    <div>
      <h1>TunnelDock</h1>
      <div class="sub">Cloudflare Tunnel automático por labels de Docker</div>
    </div>
    <button class="btn-refresh" id="refresh-btn" onclick="manualRefresh()">Actualizar</button>
  </div>

  <div class="tabs" id="tabs">
    <button class="tab-btn active" data-tab="managed" onclick="switchTab('managed')">Rutas gestionadas</button>
    <button class="tab-btn" data-tab="unmanaged" onclick="switchTab('unmanaged')">Rutas no gestionadas</button>
    <button class="tab-btn" data-tab="dns" onclick="switchTab('dns')">Registros DNS</button>
    <button class="tab-btn" data-tab="policies" onclick="switchTab('policies')">Políticas Access</button>
    <button class="tab-btn" data-tab="logs" onclick="switchTab('logs')">Logs</button>
    <button class="tab-btn" data-tab="help" onclick="switchTab('help')">Ayuda</button>
  </div>

  <div class="tab-panel" id="tab-managed">
    <section>
      <h2>Rutas gestionadas</h2>
      <div class="table-scroll" id="tunnels-table"></div>
    </section>
  </div>

  <div class="tab-panel" id="tab-unmanaged" hidden>
    <section>
      <h2>Rutas no gestionadas</h2>
      <p class="sub">Reglas de ingress que existen en el tunnel pero que tunneldock no ha creado -- configuradas a mano.</p>
      <div class="table-scroll" id="unmanaged-table"></div>
    </section>
  </div>

  <div class="tab-panel" id="tab-dns" hidden>
    <section>
      <h2>Registros DNS de mrts.es</h2>
      <p class="sub">Todos los registros de la zona, no solo los del tunnel -- para tener el DNS completo a la vista sin entrar al dashboard de Cloudflare.</p>
      <div class="table-scroll" id="dns-table"></div>
    </section>
  </div>

  <div class="tab-panel" id="tab-policies" hidden>
    <section>
      <h2>Políticas Access disponibles</h2>
      <p class="sub">Políticas reutilizables de tu cuenta de Cloudflare. Usa <code>tunneldock.access=&lt;nombre&gt;</code> para proteger una ruta con una de estas.</p>
      <div class="table-scroll" id="policies-table"></div>
    </section>
  </div>

  <div class="tab-panel" id="tab-logs" hidden>
    <section>
      <h2>Logs recientes</h2>
      <div id="logs"></div>
    </section>
  </div>

  <div class="tab-panel" id="tab-help" hidden>
    <section>
      <h2>Cómo funciona</h2>
      <p>TunnelDock escucha los eventos de Docker (arranque/parada de contenedores) y, según sus labels, crea o borra automáticamente rutas de Cloudflare Tunnel (DNS + regla de ingress) y, opcionalmente, protección de Access.</p>

      <h2 style="margin-top:24px">Las pestañas</h2>
      <ul>
        <li><b>Rutas gestionadas</b>: lo que tunneldock ha creado y sigue vigilando. Cada fila se puede borrar a mano con el icono de papelera.</li>
        <li><b>Rutas no gestionadas</b>: reglas de ingress que existen en el tunnel pero que tunneldock no creó -- configuradas a mano en algún momento. Se pueden borrar igual, pero tunneldock nunca las toca por su cuenta.</li>
        <li><b>Registros DNS</b>: la zona completa de Cloudflare (no solo lo relacionado con el tunnel), para verlo todo de un vistazo.</li>
        <li><b>Políticas Access</b>: qué políticas reutilizables existen, a quién dejan entrar y cuántas apps las usan -- para saber qué nombre poner en <code>tunneldock.access</code>.</li>
        <li><b>Logs</b>: las últimas 500 líneas de log de tunneldock, coloreadas por nivel.</li>
      </ul>

      <h2 style="margin-top:24px">Labels disponibles</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Label</th><th>Qué hace</th></tr></thead>
          <tbody>
            <tr><td><code>tunneldock.assign=true</code></td><td>Obligatorio. Activa la gestión de este contenedor.</td></tr>
            <tr><td><code>tunneldock.hostname=miapp</code></td><td>Subdominio a usar. Si no incluye el dominio completo, se le añade automáticamente. Sin este label, se usa el nombre del contenedor.</td></tr>
            <tr><td><code>tunneldock.service.port=8080</code></td><td>Puerto interno del contenedor al que apuntar. Por defecto usa el primer puerto publicado.</td></tr>
            <tr><td><code>tunneldock.service.protocol=https</code></td><td>Protocolo hacia el origen. Por defecto <code>http</code>.</td></tr>
            <tr><td><code>tunneldock.service.path=/admin</code></td><td>Ruta añadida a la URL de destino, opcional.</td></tr>
            <tr><td><code>tunneldock.access=Nombre de política</code></td><td>Protege la ruta con una política de Access reutilizable ya existente (ver pestaña "Políticas Access"). Quitar el label borra la protección que tunneldock creó.</td></tr>
            <tr><td><code>tunneldock.originRequest.noTLSVerify=true</code></td><td>Y el resto de ajustes de <code>originRequest</code> del tunnel (http2Origin, connectTimeout, tcpKeepAlive...).</td></tr>
          </tbody>
        </table>
      </div>

      <h2 style="margin-top:24px">El botón "Actualizar"</h2>
      <p>El auto-refresco de cada 15s solo relee datos locales (gratis, sin límite). Los datos de Cloudflare (rutas no gestionadas, DNS, políticas) se cachean 20s y no se piden en el auto-refresco para no gastar la cuota de la API -- el botón "Actualizar" de arriba fuerza una lectura fresca de todo.</p>

      <h2 style="margin-top:24px">Cosas a tener en cuenta</h2>
      <ul>
        <li>Solo actúa en <b>transiciones</b> de estado (parado→corriendo) o cuando el contenedor se <b>recrea</b> (labels nuevos). Un contenedor que ya estaba corriendo antes de que tunneldock arrancase se recoge en su primera pasada de arranque.</li>
        <li>Al parar un contenedor gestionado, la ruta no se borra al instante: espera un margen de gracia (por defecto 5 minutos) antes de eliminar el DNS y el ingress, para no generar ruido en cambios/reinicios cortos.</li>
        <li>tunneldock solo gestiona (crea, actualiza, borra) lo que él mismo ha creado. Rutas y Access Applications configuradas a mano en Cloudflare nunca se tocan por su cuenta -- salvo que tú añadas el label a algo que ya existía, en cuyo caso lo adopta.</li>
        <li>El icono de papelera de las tablas de rutas actúa sobre Cloudflare directamente y no tiene margen de gracia -- es inmediato.</li>
      </ul>
    </section>
  </div>

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

const TRASH_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4M6.5 7.2v4M9.5 7.2v4M3.5 4l.7 8.4a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9L12.5 4"/></svg>';

function accessBadge(hostname, accessProtection) {
  const protection = accessProtection[hostname];
  if (!protection) return '<span class="badge muted">sin protección</span>';
  const names = protection.policies.length ? protection.policies.join(', ') : protection.appName;
  return \`<span class="badge accent" title="\${esc(protection.appName)}">\${esc(names)}</span>\`;
}

function showToast(message, type) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = \`toast \${type}\`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

async function deleteRoute(hostname, btn) {
  if (!confirm(\`¿Borrar la ruta \${hostname}?\n\nEsto elimina el registro DNS y la regla de ingress en Cloudflare. No se puede deshacer.\`)) return;

  const row = btn.closest('tr');
  row.classList.add('row-deleting');
  btn.disabled = true;

  try {
    const res = await fetch('/api/routes/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body.error || 'delete failed');

    showToast(\`Ruta \${hostname} borrada correctamente\`, 'success');
    await refreshState(true, true);
  } catch (e) {
    showToast(\`No se pudo borrar \${hostname}: \${e.message}\`, 'error');
    row.classList.remove('row-deleting');
    btn.disabled = false;
  }
}
window.deleteRoute = deleteRoute;

// unmanagedRoutes/accessProtection only arrive when we explicitly ask for
// live=1 (page load, manual refresh). The automatic poll omits them to
// avoid spending Cloudflare's account-wide rate limit in the background --
// keep showing the last known values in between instead of blanking them.
let lastLive = { unmanagedRoutes: [], accessProtection: {}, reusablePolicies: [], dnsRecords: [] };

async function refreshState(live, fresh) {
  const params = [];
  if (live) params.push('live=1');
  if (fresh) params.push('fresh=1');
  const res = await fetch('/api/state' + (params.length ? '?' + params.join('&') : ''));
  const data = await res.json();
  if (live) {
    lastLive = {
      unmanagedRoutes: data.unmanagedRoutes || [],
      accessProtection: data.accessProtection || {},
      reusablePolicies: data.reusablePolicies || [],
      dnsRecords: data.dnsRecords || [],
    };
  }
  data.unmanagedRoutes = lastLive.unmanagedRoutes;
  data.accessProtection = lastLive.accessProtection;
  data.reusablePolicies = lastLive.reusablePolicies;
  data.dnsRecords = lastLive.dnsRecords;

  const tunnelEntries = Object.entries(data.tunnels || {});
  const tunnelsHtml = tunnelEntries.length === 0
    ? '<div class="empty">Ninguna ruta gestionada todavía</div>'
    : \`<table><thead><tr><th>Hostname</th><th>Servicio</th><th>Access</th><th>Estado</th><th></th></tr></thead><tbody>
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
            <td>\${stateBadge}</td>
            <td><button class="btn-delete" title="Borrar ruta" onclick="deleteRoute('\${esc(hostname)}', this)">\${TRASH_ICON}</button></td>
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
            <td><button class="btn-delete" title="Borrar ruta" onclick="deleteRoute('\${esc(r.hostname)}', this)">\${TRASH_ICON}</button></td>
          </tr>\`).join('')}
      </tbody></table>\`;
  document.getElementById('unmanaged-table').innerHTML = unmanagedHtml;

  const policies = data.reusablePolicies || [];
  const policiesHtml = policies.length === 0
    ? '<div class="empty">No hay políticas de Access reutilizables en esta cuenta</div>'
    : \`<table><thead><tr><th>Nombre</th><th>Quién entra</th><th>Decisión</th><th>Sesión</th><th>Usada por</th></tr></thead><tbody>
        \${policies.map(p => \`<tr>
            <td><code>\${esc(p.name)}</code></td>
            <td>\${esc(p.summary)}</td>
            <td><span class="badge \${p.decision === 'allow' ? 'ok' : 'accent'}">\${esc(p.decision)}</span></td>
            <td>\${esc(p.sessionDuration)}</td>
            <td>\${p.appCount} app\${p.appCount === 1 ? '' : 's'}</td>
          </tr>\`).join('')}
      </tbody></table>\`;
  document.getElementById('policies-table').innerHTML = policiesHtml;

  const records = (data.dnsRecords || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const dnsHtml = records.length === 0
    ? '<div class="empty">No se han podido leer los registros DNS</div>'
    : \`<table><thead><tr><th>Tipo</th><th>Nombre</th><th>Contenido</th><th>Proxied</th><th>TTL</th></tr></thead><tbody>
        \${records.map(r => \`<tr>
            <td><span class="badge muted">\${esc(r.type)}</span></td>
            <td><code>\${esc(r.name)}</code></td>
            <td><code>\${esc(r.content)}</code></td>
            <td>\${r.proxied ? '<span class="badge ok">sí</span>' : '<span class="badge muted">no</span>'}</td>
            <td>\${r.ttl === 1 ? 'auto' : r.ttl}</td>
          </tr>\`).join('')}
      </tbody></table>\`;
  document.getElementById('dns-table').innerHTML = dnsHtml;
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.hidden = panel.id !== 'tab-' + name;
  });
}
window.switchTab = switchTab;

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

async function manualRefresh() {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.textContent = 'Actualizando...';
  try {
    await Promise.all([refreshState(true, true), refreshLogs()]);
    showToast('Datos actualizados', 'success');
  } catch (e) {
    showToast('No se pudo actualizar: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Actualizar';
  }
}
window.manualRefresh = manualRefresh;

// Initial load fetches everything, including the Cloudflare-backed data.
// The recurring timer below only hits the free, local part of /api/state --
// see refreshState().
refreshState(true).catch(console.error);
refreshLogs().catch(console.error);
setInterval(refresh, 15000);
</script>
</body>
</html>`;
