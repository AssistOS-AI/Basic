---
id: DS004
title: WebTTY Agent
status: implemented
owner: ploinky-team
summary: Defines the confined WebTTY runtime and its authenticated RoutingServer locator.
---

# DS004 WebTTY Agent

## Core Content

`webtty` is a start-only HTTP and Server-Sent Events agent. Its process listens
on container port `7681`; it does not run AgentServer and has no implicit
primary route.

The manifest must not publish a host port or declare `openPorts`, `ports`,
`hostPort`, or `additionalServerPort`. Authenticated browser clients reach the
service only through Ploinky's confined runtime relay at
`/base-agent-additional-server/webtty/7681/`. Query parameters such as `dir`
are appended to that same-origin route and do not select a host or private
address.

The agent remains safe to start as a no-wait Explorer dependency. Availability
is determined when the authorized relay request reaches port `7681`, rather
than by promoting the custom listener to a Ploinky primary service.

## Decisions & Questions

### Question #1: Why is WebTTY not modeled as an AgentServer?

Response: WebTTY serves a browser terminal protocol directly and has no MCP
contract. Keeping it start-only makes the runtime descriptor accurately omit
an implicit port-7000 primary service.
