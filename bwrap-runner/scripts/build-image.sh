#!/bin/sh
set -eu

image="${BWRAP_RUNNER_IMAGE:-assistos/bwrap-runner:node24-python-bookworm}"

if command -v podman >/dev/null 2>&1; then
    runtime=podman
elif command -v docker >/dev/null 2>&1; then
    runtime=docker
else
    echo "bwrap-runner image build requires podman or docker in PATH." >&2
    exit 1
fi

if "$runtime" image inspect "$image" >/dev/null 2>&1; then
    echo "[bwrap-runner] image already available: $image"
    exit 0
fi

script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
agent_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
repo_dir="$(CDPATH= cd -- "$agent_dir/.." && pwd)"
workspace_dir="$(CDPATH= cd -- "$repo_dir/.." && pwd)"
dockerfile="${BWRAP_RUNNER_DOCKERFILE:-}"

if [ -z "$dockerfile" ]; then
    candidate="$workspace_dir/container-image-builds/images/bwrap-runner/Dockerfile"
    if [ -f "$candidate" ]; then
        dockerfile="$candidate"
    fi
fi

if [ -z "$dockerfile" ]; then
    echo "[bwrap-runner] centralized Dockerfile not found; pulling image $image with $runtime"
    exec "$runtime" pull "$image"
fi

if [ ! -f "$dockerfile" ]; then
    echo "[bwrap-runner] BWRAP_RUNNER_DOCKERFILE does not exist: $dockerfile" >&2
    exit 1
fi

dockerfile_dir="$(CDPATH= cd -- "$(dirname "$dockerfile")" && pwd)"
dockerfile="$dockerfile_dir/$(basename "$dockerfile")"

cd "$agent_dir"
echo "[bwrap-runner] building image $image with $runtime from $dockerfile"
exec "$runtime" build -t "$image" -f "$dockerfile" .
