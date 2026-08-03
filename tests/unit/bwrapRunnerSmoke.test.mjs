// Host-independent contract test for the real healthcheck entry point. Native
// image publication runs the separate non-skipping two-mode integration gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HEALTHCHECK = path.resolve(__dirname, '../../bwrap-runner/bin/healthcheck.mjs');
const MANIFEST = path.resolve(__dirname, '../../bwrap-runner/manifest.json');

test('compatibility manifest retains privilege and gives the two-probe health contract time to report', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    assert.equal(manifest.containerSecurity?.privileged, true);
    assert.equal(manifest.health?.readiness?.timeout, 30);
});

test('healthcheck.mjs reports a canonical capability outcome without skipping', { concurrency: false }, () => {
    const result = spawnSync(process.execPath, [HEALTHCHECK], {
        encoding: 'utf8',
        timeout: 15_000,
    });
    assert.ok(result.status === 0 || result.status === 1, `unexpected status ${result.status}`);
    const line = String(result.stdout || '').trim().split('\n').pop();
    assert.ok(line, `healthcheck produced no JSON. stderr=${result.stderr}`);
    const record = JSON.parse(line);
    assert.equal(record.runnerAbi, 2);
    if (result.status === 0) {
        assert.equal(record.ok, true);
        assert.equal(record.code, 'BWRAP_RUNNER_READY');
        assert.match(record.capability.mode, /^(?:private|empty)$/);
        assert.equal(record.capability.minimum, 'private-or-empty');
    } else {
        assert.equal(record.ok, false);
        assert.equal(record.code, 'PLOINKY_BWRAP_CAPABILITY_UNAVAILABLE');
        assert.equal(record.capability?.minimum, 'private-or-empty');
    }
});

test('healthcheck accepts only the trusted tighten-only private requirement', () => {
    const result = spawnSync(process.execPath, [HEALTHCHECK, '--minimum=private-or-empty'], {
        encoding: 'utf8',
        timeout: 15_000,
    });
    assert.equal(result.status, 1);
    const record = JSON.parse(String(result.stdout || '').trim().split('\n').pop());
    assert.equal(record.code, 'BWRAP_RUNNER_INVALID_TRUSTED_OPTION');
});
