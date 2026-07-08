---
id: DS003
title: Cloudflared Tunnel Agent
status: implemented
owner: ploinky-team
summary: Defines the Basic cloudflared connector agent that runs Cloudflare Tunnel inside Ploinky box without owning Ploinky routing or direct media/data-plane exposure.
---

# DS003 Cloudflared Tunnel Agent

## Introduction

The `cloudflared` agent is a Basic catalog connector for running Cloudflare
Tunnel inside Ploinky box. Its canonical Ploinky agent id is
`agent:basic/cloudflared`. The agent creates an outbound tunnel connector so
Cloudflare can route a published HTTP or WebSocket hostname to a service that is
reachable from inside the `cloudflared` container.

## Core Content

The manifest must use the official Cloudflare image
`docker.io/cloudflare/cloudflared:latest`. Ploinky starts that image with the
custom command `tunnel --no-autoupdate run`, which relies on the image entrypoint
to execute `cloudflared tunnel --no-autoupdate run`.

The tunnel credential must be supplied as the container environment variable
`TUNNEL_TOKEN`, sourced from the workspace variable
`CLOUDFLARED_TUNNEL_TOKEN`. The manifest must not contain raw tunnel tokens,
Cloudflare API tokens, JWTs, `PLOINKY_MASTER_KEY`, Ploinky agent secrets, or
other committed credentials.

The manifest readiness protocol must be `none`. `cloudflared` does not expose a
stable in-container application readiness port for this catalog contract, and
tunnel connection failures should be diagnosed from process exit state and
container logs rather than by routing Ploinky MCP readiness traffic to it.

The default Cloudflare published-application route for Ploinky box must target
the Ploinky router from the connector container's point of view:
`http://host.containers.internal:8080`. Operators must not configure that route
as `localhost:8080`, because `localhost` inside the connector means the
`cloudflared` container itself.

The `cloudflared` agent must not declare `routerAccess`, `httpServices`,
`guest`, `ssoProvider`, `ports`, or `openPorts`. It does not own Ploinky
routing, authentication, MCP policy, guest access, HTTP service publication, or
direct port publication. It is an outbound connector for router-hosted HTTP and
WebSocket traffic.

This catalog contract does not define a general TCP or UDP exposure mechanism.
Direct media or data-plane surfaces such as LiveKit media, TURN, and OnlyOffice
editor ports remain explicit Ploinky box publication responsibilities through
`--publish` or `--webmeet-ports`, with their own credentials and specs. The
Ploinky router remains the public control-plane entrypoint for agent
application surfaces such as MCP, task status, chat completions, internal
callbacks, and storage endpoints.

## Decisions & Questions

### Question #1: Why does the agent target the router instead of individual agent ports?

Response: Ploinky's router owns authentication, policy, route prefixing, MCP
proxying, task status, and public HTTP service decisions. Tunneling arbitrary
agent ports would bypass that boundary. The connector therefore documents the
router target `http://host.containers.internal:8080` as the supported HTTP and
WebSocket origin for Cloudflare published applications.

### Question #2: Why is readiness set to `none`?

Response: A Cloudflare Tunnel connector is useful only after it authenticates to
Cloudflare and establishes outbound connections, but this catalog agent does
not provide an agent-local HTTP readiness service for Ploinky to probe. Marking
readiness as `none` avoids implying that MCP or TCP readiness checks describe
the tunnel's public availability.

### Question #3: Why are LiveKit and OnlyOffice excluded from this tunnel contract?

Response: LiveKit media, TURN, and editor data-plane ports are not generic
router-hosted application routes. They require explicit publication and
credential decisions. In Ploinky box, those direct surfaces remain operator
choices expressed with `--publish` or convenience flags such as
`--webmeet-ports` rather than hidden behavior in the cloudflared agent.

## Conclusion

`agent:basic/cloudflared` is a narrow Cloudflare Tunnel connector for exposing
Ploinky router-hosted HTTP and WebSocket surfaces from inside Ploinky box. It
must keep secrets out of source files, avoid direct agent-port publication, and
leave direct media or editor data-plane exposure to explicit Ploinky box
`--publish` decisions.
