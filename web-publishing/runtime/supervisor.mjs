#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';

import { buildCloudflaredIngress, normalizePublishingConfig } from '../lib/routes.mjs';
import { writeAndValidateNginxConfig } from '../lib/nginx-config.mjs';
import { readConfig, readSecretState, writeStatus } from './status-store.mjs';

function redactArgs(args) {
    return args.map((arg, index) => {
        if (args[index - 1] === '--token') return '[redacted-token]';
        return String(arg).replace(/eyJ[A-Za-z0-9._-]+/g, '[redacted-token]');
    });
}

async function startNginx(config) {
    await writeAndValidateNginxConfig(config.exposures);
    const nginxCheck = spawnSync('nginx', ['-v'], { encoding: 'utf8' });
    if (nginxCheck.error?.code === 'ENOENT') {
        await writeStatus({ nginx: { state: 'unavailable' } });
        return null;
    }
    const child = spawn('nginx', ['-g', 'daemon off;', '-c', process.env.WEB_PUBLISHING_NGINX_CONFIG_FILE || '/tmp/web-publishing-nginx.conf'], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: process.env,
    });
    await writeStatus({ nginx: { state: 'running', pid: child.pid } });
    return child;
}

async function startCloudflared(config, secretState = {}) {
    const token = String(
        process.env.TUNNEL_TOKEN
        || process.env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN
        || secretState.tunnelToken
        || ''
    ).trim();
    const args = ['tunnel', '--no-autoupdate', 'run'];
    if (token) args.push('--token', token);
    await writeStatus({
        cloudflared: {
            state: token ? 'starting' : 'missing-token',
            tokenSet: Boolean(token),
            args: redactArgs(args),
        },
        ingress: buildCloudflaredIngress(config.exposures),
    });
    if (!token || !String(config.mode || '').includes('cloudflare')) {
        return null;
    }
    const child = spawn('cloudflared', args, {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: process.env,
    });
    await writeStatus({
        cloudflared: {
            state: 'running',
            pid: child.pid,
            tokenSet: true,
            args: redactArgs(args),
        },
    });
    return child;
}

async function main() {
    const saved = await readConfig();
    const secretState = await readSecretState();
    const config = normalizePublishingConfig(saved, process.env);
    await writeStatus({ state: 'starting', mode: config.mode });
    const children = [];
    const nginx = await startNginx(config);
    if (nginx) children.push(nginx);
    const cloudflared = await startCloudflared(config, secretState);
    if (cloudflared) children.push(cloudflared);
    await writeStatus({ state: 'running', mode: config.mode });

    const stop = (signal) => {
        for (const child of children) child.kill(signal);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    setInterval(() => {}, 60_000);
}

main().catch(async (error) => {
    await writeStatus({
        state: 'failed',
        error: error?.message || String(error),
    }).catch(() => {});
    process.stderr.write(`[web-publishing] ${error?.stack || error}\n`);
    process.exitCode = 1;
});
