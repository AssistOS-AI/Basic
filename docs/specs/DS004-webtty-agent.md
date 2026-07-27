---
id: DS004
title: WebTTY Agent
status: implemented
owner: ploinky-team
summary: Defines the confined WebTTY runtime and its authenticated RoutingServer locator.
---

# DS004 WebTTY Agent

## Core Content

`webtty` is a start-only HTTP and Server-Sent Events agent. Its verified image
entrypoint listens on container port `7681`; it does not run AgentServer.

The manifest must not publish a host port or declare `openPorts`, `ports`,
`hostPort`, or `additionalServerPort`. It declares one authenticated
`httpServices` target on private container port `7681`. Authenticated browser
clients reach it only through the same-origin Router path `/services/webtty/`.
Query parameters such as `dir` are appended to that locator and do not select a
host or private address.

The agent remains safe to start as a no-wait Explorer dependency. Availability
is first gated by an in-container loopback readiness probe on port `7681`, then
confirmed for users when the authorized Router service reaches that same
listener. The mapping remains Router-private and cannot become an outer Box
publication.

## Decisions & Questions

### Question #1: Why is WebTTY not modeled as an AgentServer?

Response: WebTTY serves a browser terminal protocol directly and has no MCP
contract. Keeping it start-only makes the runtime descriptor accurately omit
an implicit port-7000 primary service.
