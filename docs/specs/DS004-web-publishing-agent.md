---
id: DS004
title: Web Publishing Agent
status: implemented
owner: ploinky-team
summary: Defines the Basic Web Publishing agent that generates Explorer public topology, supervises nginx and optional Cloudflare Tunnel, and exposes only admin settings and MCP controls.
---

# DS004 Web Publishing Agent

## Introduction

The `web-publishing` agent is the Basic catalog agent that owns Explorer QA and production public topology. Its canonical Ploinky agent id is `agent:basic/web-publishing`. It replaces the Explorer QA/prod dependency on `basic/cloudflared` with a provider-backed publishing control plane that can generate public URLs before sibling agents resolve their environment.

## Core Content

The manifest must use the custom image `docker.io/assistos/web-publishing-agent:node24-nginx-cloudflared`. That image supplies the Ploinky Node runtime, nginx, and the Cloudflare `cloudflared` binary. The long-lived process is `node /code/runtime/supervisor.mjs`; the Ploinky AgentServer sidecar runs through `sh /Agent/server/AgentServer.sh`; readiness is MCP-based.

The agent must not declare `routerAccess`, `httpServices`, `guest`, `ssoProvider`, or top-level `ports`. The control plane is Explorer admin settings plus admin MCP tools. The default data-plane profile may publish nginx on loopback through `profiles.default.openPorts`, and a separate `lan` profile may bind that nginx port to `0.0.0.0` as an explicit reviewed data-plane exposure. This does not create a public dashboard route or direct MCP/control route.

The manifest must expose one admin-only Explorer settings entry with key `web-publishing-settings`, label `Web Publishing`, plugin key `web-publishing/web-publishing-settings`, and settings component `web-publishing-settings`. The corresponding plugin lives under `web-publishing/IDE-plugins/web-publishing-settings/` and uses admin MCP tools for reads, validation, and apply operations. The dashboard must show secret state as present or missing and must not render saved tokens back to the browser.

The provider contract is declared through `providesConfig`. The provider may output public topology variables such as `ONLYOFFICE_PUBLIC_URL`, `ONLYOFFICE_CALLBACK_BASE_URL`, `WEBMEET_PUBLIC_LIVEKIT_URL`, `WEBMEET_TLS_HOSTNAME`, and `WEBMEET_TURN_HOST`. It may output the scoped `WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN` only as a sensitive Web Publishing-owned value. Operator inputs use Web Publishing-scoped names such as `WEB_PUBLISHING_BASE_DOMAIN`, `WEB_PUBLISHING_PUBLIC_URL`, and `WEB_PUBLISHING_CERT_EMAIL`; old public topology variable names are outputs, not setup inputs. It must not output generated or shared-generated service secrets such as `WEBMEET_LIVEKIT_API_KEY`, `WEBMEET_LIVEKIT_API_SECRET`, `WEBMEET_TURN_PASSWORD`, `PLOINKY_WEBMEET_MASTER_KEY`, `ONLYOFFICE_JWT_SECRET`, or `JWT_SECRET`.

The legacy unscoped Cloudflare tunnel token name is not a Web Publishing input, output, alias, or documented setup path. Existing standalone `basic/cloudflared` users may continue to use the older connector agent, but Explorer QA/prod must not use it as a Web Publishing fallback.

Route validation must require HTTP or HTTPS origin URLs with explicit ports, reject raw Ploinky AgentServer/MCP port `7000`, enforce configured base-domain ownership for managed hostnames, and render deterministic nginx and Cloudflare ingress output. nginx config reload is gated by `nginx -t`; generated configs and status payloads must not contain tokens, API keys, JWTs, cookies, generated secrets, or authorization headers.

Cloudflare DNS mutation is opt-in. Token mode can start `cloudflared tunnel --no-autoupdate run --token <token>` when the scoped token is configured. API mode may create or update remote tunnel ingress using the Cloudflare v4 API and may create CNAME records only after the admin explicitly requests DNS mutation and the zone configuration is present. When API mode creates a new tunnel, the returned token is written only to the private agent secret-state file and then emitted through the sensitive startup provider output so Ploinky persists it in encrypted workspace vars; MCP responses and status payloads expose only presence flags.

LiveKit and TURN media remain explicit direct media-plane exposure in the WebMeet infra agent. Cloudflare HTTP tunnels can publish HTTP/WebSocket signaling, but they do not carry WebRTC UDP media. Web Publishing should warn operators when a selected mode could be mistaken for complete WebMeet media exposure.

## Decisions & Questions

### Question #1: Why is Web Publishing separate from the existing cloudflared agent?

Response:
The existing `cloudflared` agent is a standalone tunnel connector. Explorer QA/prod needs a richer owner for generated public topology, nginx route normalization, provider preflight, dashboard configuration, and Cloudflare API planning. Keeping that in a new agent avoids changing the standalone connector contract and makes Explorer's cutover explicit.

### Question #2: Why does the dashboard use Explorer settings plus admin MCP instead of a public route?

Response:
Publishing configuration can affect internet-facing routes and Cloudflare DNS. It belongs behind Explorer admin settings and router-mediated admin MCP tools. A public dashboard HTTP route would widen the attack surface without adding needed capability.

### Question #3: Why are WebMeet and OnlyOffice generated secrets excluded from provider output?

Response:
Those secrets are already owned by Ploinky generated/shared-generated secret mechanics in their respective agents. Web Publishing owns public topology and provider-owned external credentials, not service credentials derived from the workspace master key.

### Question #4: Why keep LiveKit/TURN media outside the Cloudflare tunnel contract?

Response:
Cloudflare Tunnel handles HTTP/WebSocket traffic. LiveKit and TURN media require explicit TCP/UDP media-plane exposure and cannot be hidden behind the Ploinky router or a Cloudflare HTTP tunnel without changing the WebRTC architecture.

## Conclusion

`agent:basic/web-publishing` is the Explorer-facing public topology owner for QA and production. It keeps the control plane admin-only, persists provider output through Ploinky's startup provider contract, treats DNS mutation as opt-in, and preserves generated-secret and media-plane ownership boundaries.
