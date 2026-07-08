# Cloudflared

`basic/cloudflared` runs Cloudflare Tunnel from inside ploinky-box and exposes admin-only MCP tools for managing a remotely configured Cloudflare Tunnel. The browser dashboard lives in Explorer Settings, but all tunnel mutations go through the `agent:basic/cloudflared` MCP tools and the Ploinky router.

## Runtime

The agent uses `docker.io/assistos/cloudflared-agent:node24-cloudflared`. The image copies the official `cloudflared` binary from `docker.io/cloudflare/cloudflared:latest` into the Ploinky Node runtime image so the container can run both:

| Process | Purpose |
| --- | --- |
| `node /code/runtime/cloudflared-supervisor.mjs` | Main process; starts `cloudflared tunnel --no-autoupdate run` and writes redacted status. |
| `sh /Agent/server/AgentServer.sh` | Sidecar; exposes admin MCP tools through the Ploinky router. |

## Required Secrets And Config

Set secrets with `ploinky var`; do not commit token values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARED_TUNNEL_TOKEN` | yes | Token consumed as `TUNNEL_TOKEN` by `cloudflared`. |
| `CLOUDFLARE_API_TOKEN` | for dashboard apply | Cloudflare API token with tunnel config and DNS permissions. |
| `CLOUDFLARE_ACCOUNT_ID` | for dashboard apply | Cloudflare account that owns the tunnel. |
| `CLOUDFLARE_ZONE_ID` | for dashboard DNS | Zone where dashboard-created CNAME records live. |
| `CLOUDFLARE_TUNNEL_ID` | for dashboard apply | Tunnel UUID. |
| `CLOUDFLARE_BASE_DOMAIN` | recommended | Limits dashboard hostnames to one domain suffix. |
| `CLOUDFLARED_ALLOWED_ORIGINS_JSON` | optional | JSON array of allowed `host.containers.internal:<port>` origins for published non-router HTTP services. |

## Ploinky Box Boundaries

Default production routing should point at the Ploinky router:

| Origin preset | Service URL | Notes |
| --- | --- | --- |
| `router` | `http://host.containers.internal:8080` | Router-hosted Explorer and agent HTTP/WebSocket surfaces. |
| `onlyoffice` | `http://host.containers.internal:8082` | Only works when that box-side host port is published. |

Cloudflare Tunnel can expose HTTP and WebSocket origins. It does not expose LiveKit UDP media by itself. LiveKit media and other direct data planes still need explicit `ploinky start explorer --publish HOST:BOX` mappings and their own app-level credentials.

## Configure Ploinky

Set the token as a workspace variable before starting the agent:

```bash
read -rsp 'Cloudflare tunnel token: ' CLOUDFLARED_TUNNEL_TOKEN
echo
ploinky var CLOUDFLARED_TUNNEL_TOKEN "$CLOUDFLARED_TUNNEL_TOKEN"
unset CLOUDFLARED_TUNNEL_TOKEN
```

Then enable and start the agent:

```bash
ploinky enable agent basic/cloudflared global
```

The agent can also be enabled by another agent manifest as a non-blocking dependency:

```json
{
  "enable": [
    "basic/cloudflared global no-wait"
  ]
}
```

Use Cloudflare Access for the router hostname unless the Ploinky router
deployment is intentionally public. Without an Access application or another
edge policy, a published application route can be reachable from the Internet.

`no-wait` is recommended when the tunnel is a convenience layer. A missing or
invalid tunnel token should not prevent the local router and workspace agents
from starting.

For direct ports that are not router-hosted HTTP/WebSocket surfaces, publish
them explicitly when creating or updating the Ploinky box:

```bash
ploinky start explorer --publish 127.0.0.1:8082:8082
ploinky start explorer --webmeet-ports
```

Use `127.0.0.1` for host-local exposure and `0.0.0.0` only when the port is
intentionally reachable on LAN/public interfaces.

## Security Boundary

Keep Ploinky application surfaces behind the router. Do not tunnel random agent
`7000` ports, MCP ports, internal callback or storage ports, or task-status
endpoints directly. Direct media or data planes such as LiveKit must have their
own credentials and remain an explicit manifest/spec decision.
