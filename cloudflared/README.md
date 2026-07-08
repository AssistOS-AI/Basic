# Cloudflared

`cloudflared` runs Cloudflare Tunnel from inside Ploinky box. It is a
connector, not a Ploinky control plane. It does not expose MCP, agent tools,
arbitrary TCP/UDP ports, LiveKit media, or OnlyOffice editor ports by itself.

## Runtime

The agent uses `docker.io/cloudflare/cloudflared:latest` and starts:

```bash
cloudflared tunnel --no-autoupdate run
```

The tunnel token is read from `TUNNEL_TOKEN` inside the container. The manifest
maps that value from the workspace variable `CLOUDFLARED_TUNNEL_TOKEN`.

## Configure Cloudflare

Create a remotely-managed Cloudflare Tunnel, copy its token, and set published
application routes in Cloudflare. Service URLs are resolved from the
`cloudflared` container's point of view.

| Public hostname | Service URL | Purpose |
| --- | --- | --- |
| `ploinky.example.com` | `http://host.containers.internal:8080` | Expose the Ploinky router through Cloudflare Tunnel. |

Use Cloudflare Access for the router hostname unless the Ploinky router
deployment is intentionally public. Without an Access application or another
edge policy, a published application route can be reachable from the Internet.

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

The agent can also be enabled by another agent manifest as a non-blocking
dependency:

```json
{
  "enable": [
    "basic/cloudflared global no-wait"
  ]
}
```

`no-wait` is recommended when the tunnel is a convenience layer. A missing or
invalid tunnel token should not prevent the local router and workspace agents
from starting.

## Ploinky Box Boundary

This agent runs inside Ploinky box. It can reach the box-side router at:

```text
http://host.containers.internal:8080
```

Do not use `localhost:8080` in Cloudflare route configuration. From inside the
`cloudflared` container, `localhost` is the `cloudflared` container itself.

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
