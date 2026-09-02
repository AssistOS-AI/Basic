import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../bwrap-runner/scripts/build-image.sh', import.meta.url));
const digest = `docker.io/assistos/bwrap-runner@sha256:${'a'.repeat(64)}`;

function runHook(t, { image = digest, cached = false, pullStatus = 0 } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-image-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const log = path.join(root, 'calls.jsonl');
    const dockerfile = path.join(root, 'Dockerfile');
    fs.writeFileSync(dockerfile, 'FROM scratch\n');
    fs.writeFileSync(path.join(root, 'podman'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RUNTIME_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') process.exit(Number(process.env.INSPECT_STATUS));
if (args[0] === 'pull') process.exit(Number(process.env.PULL_STATUS));
if (args[0] !== 'build') process.exit(99);
`, { mode: 0o755 });
    const env = {
        ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`,
        BWRAP_RUNNER_DOCKERFILE: dockerfile, RUNTIME_LOG: log,
        INSPECT_STATUS: cached ? '0' : '1', PULL_STATUS: String(pullStatus),
    };
    delete env.BWRAP_RUNNER_IMAGE;
    if (image !== null) env.BWRAP_RUNNER_IMAGE = image;
    const result = spawnSync('/bin/sh', [script], { env, encoding: 'utf8' });
    assert.ifError(result.error);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { result, calls, dockerfile };
}

test('missing digest reference pulls the exact image even when a local Dockerfile exists', t => {
    const { result, calls } = runHook(t);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [['image', 'inspect', digest], ['pull', digest]]);
});

test('available digest reference avoids both pulling and local rebuilding', t => {
    const { result, calls } = runHook(t, { cached: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [['image', 'inspect', digest]]);
});

test('failed immutable pull preserves its failure and cannot fall back to a local build', t => {
    const { result, calls } = runHook(t, { pullStatus: 17 });
    assert.equal(result.status, 17);
    assert.deepEqual(calls, [['image', 'inspect', digest], ['pull', digest]]);
});

test('an explicit development tag retains the centralized local-build behavior', t => {
    const image = 'localhost/bwrap-runner:development';
    const { result, calls, dockerfile } = runHook(t, { image });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ['image', 'inspect', image]);
    assert.deepEqual(calls[1].slice(0, 4), ['build', '-t', image, '-f']);
    assert.equal(fs.realpathSync(calls[1][4]), fs.realpathSync(dockerfile));
    assert.equal(calls[1][5], '.');
});

test('direct invocation defaults to the same image as the checked-in manifest', t => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../bwrap-runner/manifest.json', import.meta.url), 'utf8'));
    const { result, calls } = runHook(t, { image: null, cached: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [['image', 'inspect', manifest.container]]);
});
