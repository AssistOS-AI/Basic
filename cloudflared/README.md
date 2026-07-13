# Cloudflared

`basic/cloudflared` runs Cloudflare Tunnel from inside ploinky-box and exposes admin-only MCP tools for managing a remotely configured Cloudflare Tunnel. The browser dashboard lives in Explorer Settings, but all tunnel mutations go through the `agent:basic/cloudflared` MCP tools and the Ploinky router.

## Runtime

The agent uses `docker.io/assistos/cloudflared-agent:node24-cloudflared`. The image copies the official `cloudflared` binary from `docker.io/cloudflare/cloudflared:latest` into the Ploinky Node runtime image so the container can run both:

| Process | Purpose |
| --- | --- |
| `node /code/runtime/cloudflared-supervisor.mjs` | Main process; starts `cloudflared tunnel --no-autoupdate run` and writes redacted status. |
| `sh /Agent/server/AgentServer.sh` | Sidecar; exposes admin MCP tools through the Ploinky router. |

The production `default` profile requires `CLOUDFLARED_TUNNEL_TOKEN`. The
`local-test` profile overrides `TUNNEL_TOKEN` with an empty optional value so
the supervisor reports `missing-token` while the admin MCP sidecar and Explorer
dashboard remain available for local UI checks.

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

## Explorer Dashboard

Explorer Settings discovers the admin-only `Cloudflare Tunnel` panel from
`cloudflared/manifest.json` and
`cloudflared/IDE-plugins/cloudflared-settings/`. The panel calls
`/cloudflared/mcp` through the Ploinky router and uses the existing admin tools:

| Tool | Dashboard use |
| --- | --- |
| `cloudflared_status` | Shows tunnel status, Cloudflare API readiness, allowed origins, and saved routes. |
| `cloudflared_routes_validate` | Validates route drafts and previews generated ingress rules. |
| `cloudflared_routes_apply` | Applies validated ingress rules and creates DNS records only when explicitly requested. |

The dashboard never displays or accepts raw tunnel tokens. DNS record creation
is unchecked by default; configure `CLOUDFLARE_ZONE_ID` and opt in before asking
the dashboard to create CNAME records. Configure secrets with `ploinky var`
before applying routes against Cloudflare.

## Ploinky Box Boundaries

Default production routing should point at the Ploinky router:

| Origin preset | Service URL | Notes |
| --- | --- | --- |
| `router` | `http://ploinky-router:8080` | The only supported origin: router-hosted Explorer and agent HTTP/WebSocket surfaces. |

The manifest uses its isolated default network. Ploinky's managed gateway joins
that network under the `ploinky-router` alias, so the connector needs no host
gateway and no shared WebMeet or office network. Origin overrides, loopback,
host-gateway targets, and sibling-agent targets are rejected. Direct media and
editor data planes are outside this agent's contract.

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

For a scratch local box that only needs the dashboard and admin MCP tools, use
the local-test profile before enabling the agent:

```bash
ploinky profile local-test
ploinky enable agent basic/cloudflared global
ploinky profile default
```

That mode does not create a live Cloudflare edge tunnel. It is intended for
checking Explorer settings and route validation wiring without a real token.

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

## Security Boundary

Keep Ploinky application surfaces behind the router. Do not tunnel random agent
`7000` ports, MCP ports, internal callback or storage ports, task-status
endpoints, or sibling-agent services directly. Direct media or data planes are
owned by their respective manifests and specs.
