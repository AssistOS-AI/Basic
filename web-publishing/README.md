# Web Publishing

`basic/web-publishing` owns Explorer public topology for QA and production profiles. It runs nginx as a local data-plane normalizer, can supervise `cloudflared` when a scoped tunnel token is present, and exposes its control plane only through Explorer admin settings and admin MCP tools.

The agent intentionally does not declare public router routes, guest access, SSO provider behavior, or a public dashboard HTTP service. LiveKit and TURN media ports remain explicit media-plane exposure in the WebMeet infra agent.

Use `WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN` for token-mode tunnel startup. The legacy unscoped tunnel token name is not a Web Publishing input or output.

Use `WEB_PUBLISHING_CERT_EMAIL` when Web Publishing should generate `WEBMEET_CERT_EMAIL` for dependent agents. Cloudflare API-created tunnel tokens are stored in the agent's private secret-state file and emitted only through the sensitive scoped provider output.
