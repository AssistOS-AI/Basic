#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const statusFile = process.env.CLOUDFLARED_STATUS_FILE || '/root/cloudflared/status.json';

async function writeStatus(update) {
  const payload = {
    updatedAt: new Date().toISOString(),
    ...update,
  };
  await fs.mkdir(path.dirname(statusFile), { recursive: true });
  await fs.writeFile(statusFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function redactArgs(args) {
  return args.map((arg) => String(arg).replace(/eyJ[A-Za-z0-9._-]+/g, '[redacted-token]'));
}

async function main() {
  const args = ['tunnel', '--no-autoupdate', 'run'];
  const tokenPresent = Boolean(String(process.env.TUNNEL_TOKEN || '').trim());

  await writeStatus({
    state: tokenPresent ? 'starting' : 'missing-token',
    pid: null,
    command: 'cloudflared',
    args: redactArgs(args),
    tokenPresent,
  });

  if (!tokenPresent) {
    process.stderr.write('[cloudflared] TUNNEL_TOKEN is required.\n');
    setInterval(() => {}, 60_000);
    return;
  }

  const child = spawn('cloudflared', args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });

  await writeStatus({
    state: 'running',
    pid: child.pid,
    command: 'cloudflared',
    args: redactArgs(args),
    tokenPresent,
  });

  const stop = (signal) => {
    child.kill(signal);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  child.on('exit', async (code, signal) => {
    await writeStatus({
      state: 'exited',
      pid: child.pid,
      code,
      signal,
      command: 'cloudflared',
      args: redactArgs(args),
      tokenPresent,
    });
    process.exitCode = typeof code === 'number' ? code : 1;
  });
}

main().catch(async (error) => {
  await writeStatus({
    state: 'failed',
    error: error?.message || String(error),
    pid: null,
  }).catch(() => {});
  process.stderr.write(`[cloudflared] ${error?.stack || error}\n`);
  process.exitCode = 1;
});
