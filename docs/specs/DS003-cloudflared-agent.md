---
id: DS003
title: Cloudflared Tunnel Agent
status: implemented
owner: ploinky-team
summary: Defines the Basic cloudflared connector agent, admin Explorer dashboard, and profile contract for running Cloudflare Tunnel inside Ploinky box without owning Ploinky routing or direct media/data-plane exposure.
---

# DS003 Cloudflared Tunnel Agent

## Introduction

The `cloudflared` agent is a Basic catalog connector for running Cloudflare
Tunnel inside Ploinky box. Its canonical Ploinky agent id is
`agent:basic/cloudflared`. The agent creates an outbound tunnel connector so
Cloudflare can route a published HTTP or WebSocket hostname to a service that is
reachable from inside the `cloudflared` container.

## Core Content

The manifest must use the custom Ploinky-compatible image
`docker.io/assistos/cloudflared-agent:node24-cloudflared`. That image embeds
the Cloudflare `cloudflared` binary into the Node-based Ploinky agent runtime so
the connector can run both a tunnel supervisor and an admin-only MCP control
plane.

The tunnel credential must be supplied as the container environment variable
`TUNNEL_TOKEN`, sourced from the workspace variable
`CLOUDFLARED_TUNNEL_TOKEN`. The manifest must not contain raw tunnel tokens,
Cloudflare API tokens, JWTs, `PLOINKY_MASTER_KEY`, Ploinky agent secrets, or
other committed credentials.

The production `default` profile must keep `TUNNEL_TOKEN` required. The
`local-test` profile may override `TUNNEL_TOKEN` to an empty optional value so a
fresh Ploinky box can start the admin MCP sidecar and Explorer dashboard without
a real Cloudflare tunnel credential. In that mode the supervisor reports a
redacted `missing-token` state and must not claim Cloudflare edge reachability.

The agent must start `node /code/runtime/cloudflared-supervisor.mjs` as its
long-lived process and must run the Ploinky AgentServer through
`sh /Agent/server/AgentServer.sh`. Readiness is MCP-based so Ploinky can verify
the admin control plane while the supervisor owns the Cloudflare Tunnel process.

The MCP policy must expose only admin-tagged tools for status, route validation,
and route application. Tunnel configuration changes require
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_TUNNEL_ID`.
DNS record creation is opt-in and additionally requires
`CLOUDFLARE_ZONE_ID`; operators may skip DNS creation and manage records
separately. When DNS creation is requested, the tool must verify the required
DNS configuration before mutating Cloudflare tunnel ingress so a missing zone
does not leave remote ingress changed without local route-state persistence.

The manifest must expose one admin-only Explorer settings entry with key
`cloudflared-settings`, label `Cloudflare Tunnel`, plugin key
`cloudflared/cloudflared-settings`, and settings component
`cloudflared-settings`. The corresponding AchillesIDE plugin lives under
`cloudflared/IDE-plugins/cloudflared-settings/` and owns the dashboard UI. The
dashboard must call the router-mediated `/cloudflared/mcp` endpoint and must use
the existing admin MCP tools rather than adding direct HTTP service exposure or
Explorer-owned Cloudflare logic.

The manifest must declare exactly `network.mode = default`, without aliases or
secondary attachments. Ploinky gives the resulting agent-owned network a
managed gateway attachment with the `ploinky-router` alias. The one supported
Cloudflare published-application origin is therefore exactly
`http://ploinky-router:8080`. The agent must reject configurable origin
presets, host-gateway names, loopback targets, alternate router ports, and
sibling-agent origins. It must not attach WebMeet or office networks.

The `cloudflared` agent must not declare `routerAccess`, `httpServices`,
`guest`, `ssoProvider`, `ports`, or `openPorts`. It does not own Ploinky
routing, authentication, guest access, HTTP service publication, or direct port
publication. It is an outbound connector plus admin control plane for
router-hosted HTTP and WebSocket traffic.

This catalog contract does not define a general TCP or UDP exposure mechanism.
Direct media or data-plane surfaces such as LiveKit media, TURN, and OnlyOffice
editor ports remain outside this connector's network and origin contract. The
Ploinky router remains the public control-plane entrypoint for agent
application surfaces such as MCP, task status, chat completions, internal
callbacks, and storage endpoints.

## Decisions & Questions

### Question #1: Why does the agent target the router instead of individual agent ports?

Response: Ploinky's router owns authentication, policy, route prefixing, MCP
proxying, task status, and public HTTP service decisions. Tunneling arbitrary
agent ports would bypass that boundary. The connector therefore documents the
router target `http://ploinky-router:8080` as the supported HTTP and
WebSocket origin for Cloudflare published applications.

### Question #2: Why is readiness MCP-based?

Response: The tunnel process itself is an outbound connector whose public
availability depends on Cloudflare, but the Ploinky agent also exposes
admin-only MCP tools for route validation and application. MCP readiness proves
that control plane is available without claiming Cloudflare edge reachability.

### Question #3: Why are LiveKit and OnlyOffice excluded from this tunnel contract?

Response: LiveKit media, TURN, and editor data-plane ports are not generic
router-hosted application routes. They require explicit publication and
credential decisions. In Ploinky box, those direct surfaces remain operator
choices expressed with `--publish` or convenience flags such as
`--webmeet-ports` rather than hidden behavior in the cloudflared agent.

### Question #4: Why does the repository include a local-test profile?

Response: The Explorer dashboard and admin MCP tools need to be testable in a
fresh local Ploinky box without depending on a real Cloudflare tunnel token.
The `local-test` profile keeps the agent sidecar reachable and records a
`missing-token` supervisor state, but it does not create a live edge tunnel or
relax the production `default` profile's required token.

### Question #5: Why does the dashboard plugin live in the cloudflared agent?

Response: The dashboard is part of the `agent:basic/cloudflared` contract. It
configures that agent's admin MCP tools and should be discoverable from the
agent manifest together with the runtime profile and policy metadata. Keeping
the AchillesIDE plugin beside the cloudflared agent avoids hard-coding
cloudflared-specific files inside Explorer and lets Explorer's plugin discovery
surface the dashboard whenever the Basic repository is installed. The plugin
must provide assets at both the normalized component root and the raw
settings-loader nested path used by Explorer's `rawRuntimePlugins` flow.

## Conclusion

`agent:basic/cloudflared` is a narrow Cloudflare Tunnel connector for exposing
Ploinky router-hosted HTTP and WebSocket surfaces from inside Ploinky box. Its
admin Explorer dashboard is plugin-owned by the agent and remains
router-mediated through `/cloudflared/mcp`. The agent must keep secrets out of
source files, avoid direct agent-port publication, and leave direct media or
editor data-plane exposure to explicit Ploinky box `--publish` decisions.
