#!/usr/bin/env node
// Canonical readiness probe for all bwrap-runner image consumers.

import {
    BWRAP_CAPABILITY_ERROR_CODE,
    BWRAP_RUNNER_ABI,
    parseTrustedProcMinimum,
    resolveBwrapCapability,
} from '../lib/capability.mjs';
import { decideNetworkPolicy } from '../lib/policy.mjs';

function emit(record) {
    try {
        process.stdout.write(`${JSON.stringify(record)}\n`);
    } catch (_) {}
}

let minimum;
try {
    minimum = parseTrustedProcMinimum(process.argv.slice(2));
} catch (error) {
    emit({
        ok: false,
        code: 'BWRAP_RUNNER_INVALID_TRUSTED_OPTION',
        message: error?.message || String(error),
        runnerAbi: BWRAP_RUNNER_ABI,
    });
    process.exit(1);
}

try {
    const capability = resolveBwrapCapability({
        minimum,
        allowNetwork: decideNetworkPolicy(process.env.BWRAP_RUNNER_ALLOW_NETWORK),
    });
    emit({
        ok: true,
        code: 'BWRAP_RUNNER_READY',
        message: `representative Bubblewrap policy succeeded with ${capability.mode} proc`,
        runnerAbi: BWRAP_RUNNER_ABI,
        capability,
    });
    process.exit(0);
} catch (error) {
    emit({
        ok: false,
        code: error?.code || BWRAP_CAPABILITY_ERROR_CODE,
        message: error?.message || 'Bubblewrap capability unavailable',
        runnerAbi: BWRAP_RUNNER_ABI,
        capability: error?.capability || null,
    });
    process.exit(1);
}
