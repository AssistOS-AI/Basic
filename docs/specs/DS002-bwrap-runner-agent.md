---
id: DS002
title: bwrap Runner Image and Local Sandbox Runtime
status: planned
owner: ploinky-team
summary: Defines the bwrap-runner OCI image and reusable local sandbox runtime that research provider agents use as their container base.
---

# DS002 bwrap Runner Image and Local Sandbox Runtime

## Introduction

`bwrap-runner` is the shared Basic sandbox image and reusable local execution
runtime for research provider agents. It is not a required Ploinky research
agent. Research backends such as `openInterpreterAgent`, DeepAnalyze, and
future providers must run in containers based on the bwrap-runner image and
start their own inner bubblewrap sandboxes locally.

The invariant is: research agents share the bwrap-runner environment, not a
central bwrap-runner MCP service. Ploinky routes chat and MCP calls to the
research provider agent; the provider agent owns backend setup and invokes the
local sandbox runner inside its own container.

## Core Content

The image and local runtime must not be documented or implemented as a
transparent replacement for Ploinky's `lite-sandbox: true` host-sandbox
backend. `lite-sandbox: true` continues to select the host sandbox path for an
entire agent process. The bwrap-runner contract instead provides a Linux OCI
environment with bubblewrap and a reusable command-staging policy that provider
agents can use from macOS or Linux hosts through the same container runtime.

New provider releases must pin the verified multiarchitecture image by digest.
The centralized Dockerfile selects immutable Node 24.20 and Python 3.12.14
Debian Trixie bases. The image supplies bubblewrap, Node.js, Python 3.12 with
pip, venv and build headers, build helpers, a maintained Git/libcurl stack,
and the shared local sandbox runner modules. Python 3.12 supports both the
pinned Open Interpreter dependencies and GPTResearcher. The image must not
install backend-specific Python packages such as `open-interpreter`; those are
owned by their respective provider agents in `copilot-agents`.

Research provider agents must use this image directly or use a documented
derived image whose sandbox base remains this image. The provider manifest,
not a bwrap-runner agent manifest, is the runtime surface that Ploinky starts.
Providers adopting the verified runner ABI 2 image must use rootless,
unprivileged outer containers with all capabilities dropped and
`no-new-privileges`. They must not request `containerSecurity.privileged: true`.
The runner selects only a proven private or empty proc policy; providers that
require private proc must report deterministic unavailability when that
capability is absent rather than relaxing confinement.

The image must install the reusable runner code at a stable image path so
provider agents can invoke it locally. The shared modules live under
`/opt/bwrap-runner/bin/` and `/opt/bwrap-runner/lib/`, and the image must
expose an executable shim at `/usr/local/bin/bwrap-sandbox-exec` that runs the
local sandbox CLI under the image's Node.js. Provider agents may invoke that
shim directly, import the library modules, or call the CLI through
`node /opt/bwrap-runner/bin/sandbox-exec.mjs`; they must not depend on a
remote `sandbox_exec` MCP tool.

The canonical published image must be produced by the manual GitHub Actions
workflow `publish-bwrap-runner.yml` in `AssistOS-AI/container-image-builds`.
That workflow checks out this repository as the build context and uses
`container-image-builds/images/bwrap-runner/Dockerfile` as the centralized
Dockerfile. It must be manual-dispatch only through `workflow_dispatch`; it
must not publish automatically on `push` or other repository events. When
dispatched, it must use native amd64 and arm64 Linux GitHub runners, Docker
Buildx, and the `DOCKERHUB_TOKEN` registry credential. It must prove each
immutable architecture digest with default and HTTP/2 Git/npm transport,
unprivileged sandbox gates, Open Interpreter preparation, and GPTResearcher
cold installation before assembling the multiarchitecture candidate. The
`node24-python-trixie` convenience tag moves only through explicit promotion;
consumers adopt the proven digest. Existing Bookworm tags are not overwritten. Local Podman or Docker builds are development and smoke-test
helpers only; they must not be treated as the release publishing authority.

If a compatibility `bwrap-runner` Ploinky agent remains in the Basic catalog,
it must be documented as optional compatibility only. Research-agent execution
must not depend on enabling it, routing to it, or calling a remote
`sandbox_exec` MCP tool. The `research-agents` bundle in `copilot-agents` must
not enable `basic/bwrap-runner`.

Provider startup or readiness must include a real nested-bwrap smoke check
before the provider reports itself ready for research execution. A failed
nested namespace probe must fail clearly with stderr and guidance instead of
letting MCP readiness report success.

The local sandbox runner must accept only a narrow typed payload from trusted
provider code: `command`, optional `stdin`, optional staged `files`, optional
`timeoutMs`, optional allowlisted `env`, and provider-selected runtime bind
metadata. Staged files must be caller-supplied data, not caller-supplied
mounts: each file entry contains a normalized relative path, string content,
and an optional `utf8` or `base64` encoding. The wrapper must reject extra
fields, including user-provided mounts, bind paths, network selectors,
capabilities, or raw bubblewrap flags. Environment forwarding must be
allowlisted and value-validated.

Runtime binding remains a local provider responsibility. A provider may bind
one provider-owned runtime directory read-only at `/runtime`, but that path
must be selected by provider code, validated under an agent-owned runtime root
such as `/data/research-runtimes`, and never accepted from chat, browser
payloads, relay payloads, invocation metadata, or another agent's MCP request.
The shared helper should retain manifest validation, conservative id/version
patterns, realpath containment checks, and symlink-escape rejection, but the
research path must not rely on a `/shared` runtime handoff to a central runner
agent.

The inner bubblewrap policy must be generated as a fixed argv policy by
`bwrap-runner/lib/policy.mjs`. The default policy must use `--die-with-parent`,
unshare user, PID, IPC, UTS, and network namespaces, clear the environment,
set only validated environment values, bind selected system paths read-only,
provide the proven private or empty `/proc`, a fresh `/dev` containing only
`null`, `zero`, `random`, and `urandom`, and a tmpfs `/tmp`, and bind per-job writable
directories at `/work` and `/outputs`. When a runtime bundle is requested,
the local runner must bind only the resolved provider-owned bundle directory
read-only at `/runtime`. The runner must not bind any portion of `/shared` into
inner jobs. Network access may be enabled only by an operator-wide
`BWRAP_RUNNER_ALLOW_NETWORK=true` setting.

The runner must copy the fixed `/etc/hosts` and `/etc/resolv.conf` contents to
private, bounded regular files and bind those copies read-only at the same
fixed destinations. It must not remount the OCI runtime's per-file mounts or
expose additional `/etc` contents. Capability probes and actual jobs use this
same policy. Probe copies are ephemeral; job copies live outside `/work` and
`/outputs` and are removed when execution ends. Caller input cannot choose
system files, devices, mount sources, or proc mode.

The wrapper must create per-job state under `BWRAP_RUNNER_STATE/jobs/<jobId>/`.
Before bubblewrap starts, it must stage accepted files only below the per-job
`work` directory, using exclusive file creation and rejecting absolute paths,
traversal, duplicate paths, unsupported encodings, oversize files, and oversize
file batches. It must spawn bubblewrap with an empty outer environment so
Ploinky secrets, derived master keys, and invocation tokens are not inherited by
the inner job. It must enforce the validated timeout and emit one structured
JSON record with job id, exit code, signal, timeout state, elapsed time, network
mode, stdout, and stderr. Output truncation must retain the tail of each stream
and report the original byte length.

The base image can install bubblewrap, but it cannot guarantee that nested
namespaces are permitted by the host kernel or by the outer Docker or Podman
runtime. Those host and OCI policies remain operator responsibilities.

`/shared` is a coordination channel among trusted enabled agents inside a
single workspace. It is not a hostile-agent isolation boundary and must not be
the required runtime delivery path for research providers. Providers may read
shared attachments or coordination artifacts only through their own resource
materialization rules, then stage accepted content into `/work`; the inner
bwrap job must not receive a broad `/shared` bind.

## Decisions & Questions

### Decision #7: Nonroot execution and capability-specific native proof

The image runs as numeric UID/GID `1000:1000`, with a writable runner state
directory and provider-owned `HOME`. Rootless Podman projects that identity with
`keep-id:uid=1000,gid=1000`; task gates retain all capabilities dropped and
`no-new-privileges`. The policy copies OCI network files and binds four fixed
devices into a fresh directory, avoiding per-file remount and new devpts
requirements without granting additional authority.

ABI 2 permits `private-or-empty`, so each native publication gate must actually
execute empty proc with filesystem and environment isolation assertions. It
must also either execute private proc or prove through the canonical resolver
that only empty proc is available. In that case a real `--minimum=private`
task must return typed terminal unavailability before creating state or staging
input. A nonzero private child exit alone is not evidence. Open Interpreter's
private minimum remains fail closed; neither outer proc binding nor a relaxed
container security policy is an acceptable substitute. Read-only image-wide
file inventory may run separately as UID0 with no capabilities; task gates
must use the image's default nonzero identity.

### Question #1: Why is bwrap-runner an image and local runtime instead of a Ploinky research agent?

Response: Research backends already need provider agents for backend-specific
runtime setup, credentials, prompts, and result normalization. Routing those
providers through a second generic runner agent adds coupling, extra MCP hops,
and a shared runtime handoff without improving the provider boundary. A shared
image and local runner keep the sandbox policy DRY while letting every provider
own its runtime and execute inside the same Linux environment on macOS and
Linux hosts.

### Question #2: Why must providers run the nested-bwrap health check before reporting ready?

Response: Ploinky readiness can otherwise observe a running provider even when
the inner bubblewrap primitive is unusable. Running the health check before a
provider reports ready makes the essential capability a startup gate and turns
host or OCI namespace failures into explicit operational errors.

### Question #3: Why is per-request network selection not exposed?

Response: Network access changes the sandbox risk profile. The implemented
contract permits only an operator-wide `BWRAP_RUNNER_ALLOW_NETWORK=true`
setting, so callers cannot request network inheritance through the tool
payload.

### Question #4: Why add a staged `files` input instead of requiring callers to generate setup code?

Response: Prompt and resource staging is a runner responsibility. A typed
`files` input keeps the command focused on the backend executable, avoids
embedding generated Node.js or shell driver code in caller commands, and lets
the path, encoding, and byte-limit rules live in audited runner policy tests.

### Question #5: Why keep runtime binding local to provider agents?

Response: Backend runtime directories are implementation details of the
provider agent that prepares them. Letting another Ploinky agent resolve and
bind them requires a shared handoff path and makes the research suite depend on
a central runner service. The local helper can still validate a single
provider-owned runtime directory before binding it at `/runtime`, while chat
and relay payloads never gain a mount path API.

### Question #6: Why ship a generic Python runtime in the image without backend-specific packages?

Response: Provider agents prepare Python research runtimes inside their own
Linux containers, using the same Python ABI as the base image. Shipping
`python3`, pip, venv, and build tooling lets a fresh workspace prepare local
provider runtimes without host Python assumptions. Backend-specific packages
such as `open-interpreter` belong to provider-owned runtime setup, not the
shared base image.

## Conclusion

`bwrap-runner` must be the narrow, testable, generic sandbox image and local
runtime shared by research provider agents. Its security posture comes from a
fixed wrapper policy, clear health checks, empty environment inheritance,
per-job state, staged data inputs, provider-local runtime binding, and explicit
limits rather than from caller-supplied bubblewrap flags, generated setup
programs, or a central runner agent.
