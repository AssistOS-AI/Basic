# bwrap-runner

Shared Basic sandbox image and local runner for bounded one-off commands inside
nested bubblewrap sandboxes from a Debian-based Node and Python container. 

## Installation

The bwrap-runner files live at the Basic repository root as `bwrap-runner/`.
Research provider agents use the published image as their container base and
invoke the local sandbox runner from inside their own provider container.
Research execution must not depend on enabling or calling a separate
`basic/bwrap-runner` Ploinky agent.

The published image installs the reusable runner code at
`/opt/bwrap-runner/bin/` and `/opt/bwrap-runner/lib/`, and adds an executable
shim at `/usr/local/bin/bwrap-sandbox-exec` that runs the local sandbox CLI
under the image's Node.js. Provider agents invoke that shim directly inside
their own container; they do not call a remote `sandbox_exec` MCP tool.

The retained compatibility manifest uses the concrete image reference
`assistos/bwrap-runner:node24-python-bookworm`. The image is based on Node
24 Bookworm and also installs a generic Python 3 toolchain (`python3`,
`python3-pip`, `python3-venv`, `python3-dev`, `python3-setuptools`,
`python3-wheel`) plus build tooling so provider agents can prepare and execute
backend runtimes with the same Linux Python ABI on macOS and Linux hosts. The
image deliberately does not install backend-specific Python packages such as
Open Interpreter. Those runtimes are owned by the provider agent. The default
profile exposes `BWRAP_RUNNER_IMAGE` with the same default for the host
`preinstall` hook. That hook runs
`scripts/build-image.sh`; if the image is missing locally, the script builds it
with Podman or Docker from the sibling `container-image-builds` checkout when
available, otherwise it pulls the published Docker Hub image before container
creation.
The runner is being migrated to an unprivileged nested-container contract. The
compatibility agent deliberately retains `containerSecurity.privileged: true`
until a replacement image built from this source passes native amd64 and arm64
unprivileged gates and is recorded by immutable digest. Keeping the declaration
during this source-only phase prevents an unproven moving tag from being treated
as rollout evidence.

The replacement image composes pinned Node 24.20 and Python 3.12 Trixie bases,
uses `USER 1000:1000`, and provides a writable `/var/lib/ploinky-bwrap-runner`
and `/home/runner`. Providers install their runtimes below their own `HOME`;
`/opt` remains image-owned. Rootless Podman uses
`--userns=keep-id:uid=1000,gid=1000` to preserve access to provider-owned data.

The canonical published image is built by manually dispatching
`publish-bwrap-runner.yml` in `AssistOS-AI/container-image-builds`. That
workflow checks out this repository as the build context, uses the centralized
Dockerfile from `container-image-builds/images/bwrap-runner/Dockerfile`, and
publishes a proven immutable candidate and optionally promotes the
`assistos/bwrap-runner:node24-python-trixie` convenience tag for both
`linux/amd64` and `linux/arm64`. It must not publish automatically on
repository pushes. Local image builds are still useful for development smoke
tests, but they are not the release publishing authority.

## Scope

This package is **generic local sandbox execution**, not a replacement for
`lite-sandbox: true` and not an owner of any backend-specific runtime.
The host `bwrap`/Seatbelt path that `lite-sandbox: true` selects is
unchanged. Provider agents that want to run a bounded command use this image
as their runtime base and invoke the local sandbox runner inside their own
container. Backend-specific runtimes (Open Interpreter, OpenHands, MLJAR,
DeepAnalyze, Agentic Data Scientist, etc.) are owned by their respective
provider agents in `copilot-agents`, prepared inside an agent-owned runtime
root, and bound into a job only by provider-selected local configuration.

If a compatibility `bwrap-runner` MCP agent remains in this repository, it is
not part of the research-agent runtime invariant. The `research-agents` bundle
must not enable it.

## Local Runner Input

Inputs:

- `command` (string, required) - shell command run via `/bin/sh -lc`.
- `stdin` (string, optional) - fed to the child process.
- `files` (array, optional) - staged under `/work` before execution.
  Each entry is `{ "path": "relative/name", "content": "...",
  "encoding": "utf8"|"base64" }`. Paths must be normalized relative paths,
  are never interpreted as host paths, and are capped by the runner's staged
  file limits.
- `timeoutMs` (number, optional) - capped server-side by
  `BWRAP_RUNNER_MAX_TIMEOUT_MS`.
- `env` (object, optional) - only allowlisted keys (`PATH`, `HOME`,
  `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`) are forwarded after value
  validation. Raw user binds, mounts, capabilities, and bwrap flags are
  not supported.
- provider-selected runtime metadata (optional) - when present the local runner
  resolves a runtime directory under an agent-owned runtime root and binds only
  that resolved directory read-only into the inner sandbox at `/runtime`.
  Manifest-derived defaults (such as `PYTHONPATH`) may be applied. Chat,
  browser, relay, and agent-to-agent payloads cannot supply mount paths or
  arbitrary flags.

Before any state directory, job, staged file, or provider runtime is touched,
the runner resolves `/usr/bin/bwrap` to an absolute executable with a frozen
device/inode/size/time identity and verifies that outer `/proc/self` represents
the runner's current PID namespace. It then tries the complete representative
policy with a private proc and, after any private failure, with a safe empty
proc. It never binds the outer proc into a task. A task payload, staged file, or
environment variable cannot select a proc mode. Trusted provider adapters may
only tighten the minimum to private proc with the fixed
`--minimum=private` process argument; they cannot loosen the capability result.
The capability ABI is `2`.

Default policy applied inside the inner sandbox:

- `--die-with-parent`, `--unshare-user`, `--unshare-pid`,
  `--unshare-ipc`, `--unshare-uts`.
- `--unshare-net` unless the runner profile opts in via
  `BWRAP_RUNNER_ALLOW_NETWORK=true`.
- `--clearenv` followed by `--setenv` for the validated allowlisted env
  only.
- Read-only binds for `/usr`, `/lib`, `/lib64`, `/bin`, `/sbin`, and a
  curated set of `/etc` files that exist in the image. `/etc/hosts` and
  `/etc/resolv.conf` use private regular-file copies (at most 64 KiB each),
  avoiding remounts of the OCI runtime's locked file mounts. Copies are outside
  the writable job directories and removed after each probe or task.
- Either `--proc /proc` for a proven private proc or `--dir /proc` for the
  proven safe fallback, followed by a fresh `/dev` containing only read-write
  device binds for `null`, `zero`, `random`, and `urandom`, and `--tmpfs /tmp`.
  No outer proc or dev directory is bound; no new devpts mount is required.
- Per-job read-write `/work` directory and a sibling `/outputs`
  directory, both created under
  `BWRAP_RUNNER_STATE/jobs/<jobId>/`.
- Optional read-only `/runtime` bind for the resolved provider-owned runtime.
- `/shared` is never bound into inner jobs.

The `files` input is the preferred way for callers to provide prompts,
resources, and small driver configuration. Callers should not embed generated
runtime code in `command` just to create `/work` files; the runner owns that
staging responsibility and keeps it testable as policy code.

The wrapper returns a single-line JSON record:

```
{
  "ok": true|false,
  "jobId": "<uuid>",
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "elapsedMs": 12,
  "network": "none",
  "runnerAbi": 2,
  "procMode": "private|empty",
  "procMinimum": "private-or-empty|private",
  "stdout": {"text": "...", "truncated": false, "byteLength": 12},
  "stderr": {"text": "...", "truncated": false, "byteLength": 0}
}
```

`stdout` and `stderr` are truncated to the configured caps
(`BWRAP_RUNNER_MAX_STDOUT_BYTES`, `BWRAP_RUNNER_MAX_STDERR_BYTES`); the
`byteLength` field reports the original size.

## Secrets policy

The runner intentionally clears the environment before invoking
`bwrap`. Ploinky-issued secrets such as `PLOINKY_DERIVED_MASTER_KEY`,
invocation tokens, and workspace secrets are **not** propagated into
inner jobs. If a tool needs credentials it must accept them through the
validated `env` allowlist (currently limited to the standard runtime
variables).

## Provider-owned runtimes

Provider agents (for example `openInterpreterAgent`) prepare a versioned
runtime under an agent-owned root such as
`/data/research-runtimes/<id>/<version>/`. Each runtime should contain a
`manifest.json` declaring the runtime id, version, optional entrypoint paths,
and optional `python.pythonPath`. The provider sets
`BWRAP_RUNNER_RUNTIME_ROOT=/data/research-runtimes` (or another absolute
agent-owned path) in the runner's child env and passes
`runtimeBundle: { id, version, digest? }` on the runner input. The local
runner resolves the runtime inside that root, rejects absolute paths,
traversal, null bytes, malformed ids/versions, missing manifest, manifest
id/version mismatches, digest mismatches, and symlink escapes, then binds the
resolved real directory read-only into the inner sandbox at `/runtime`.

`/shared` is a coordination channel among trusted, explicitly enabled Ploinky
agents in a workspace. It is not a hostile-agent security boundary. Operators
who enable a malicious provider agent could have it write attacker-controlled
data into the shared directory. `/shared` is not the required runtime handoff
path for research providers, and the runner does not bind any portion of
`/shared` into inner jobs.

## Readiness health check

The manifest `agent` command runs `bin/healthcheck.mjs` before starting
`AgentServer.sh`, and `healthcheck.sh` wires the same probe into
Ploinky's readiness loop. Both paths run the same canonical, real
representative policy used to select the task proc mode. Readiness returns one
bounded JSON record containing `runnerAbi`, the selected capability, its
trusted minimum, the frozen binary identity, and safe probe diagnostics. If
neither proc mode meets the minimum, readiness and task execution fail before
task mutation with `PLOINKY_BWRAP_CAPABILITY_UNAVAILABLE`. This image cannot bake host sysctls such as
`kernel.unprivileged_userns_clone` in; operators must configure those
settings on the host.

`tests/integration/bwrapRunnerNative.mjs` has no skip path. Empty proc must
execute a real command with the production policy, proving authorized writes,
hidden sibling/source paths, read-only system files, the fixed device set, and
environment clearing. Private proc must either pass those execution assertions
or produce canonical evidence that only empty proc is available. The latter
case also runs a real private-only task and requires typed terminal rejection
before state creation or file staging. Its JSON distinguishes executed policies
from unavailable ones. Open Interpreter retains its private minimum.

## Limitations

- Nested bubblewrap requires the host and outer OCI runtime to permit
  user namespace creation. The image ships `bwrap` but cannot relax
  host kernel or runtime policy. Ploinky does not currently expose a
  manifest field for raw OCI flags, and adding one is out of scope for
  this iteration.
- The retained privileged compatibility manifest is not permission to publish
  or consume this source through a mutable tag. Privilege removal and digest
  pinning remain gated on the native image evidence described above.
- Networked jobs require an explicit operator opt-in via
  `BWRAP_RUNNER_ALLOW_NETWORK=true`. Per-request network selection is
  intentionally not exposed.
- This package does not transparently replace host bwrap. The
  `getRuntimeForAgent()` selector is unchanged, and `lite-sandbox:
  true` still dispatches to host bwrap on Linux or Seatbelt on macOS.
