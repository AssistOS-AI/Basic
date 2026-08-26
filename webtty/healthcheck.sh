#!/bin/sh
set -eu

node - <<'NODE'
const net = require('node:net');
const port = Number.parseInt(process.env.WEBTTY_PORT || '7681', 10);
const socket = net.createConnection({ host: '127.0.0.1', port });
const timer = setTimeout(() => socket.destroy(new Error('timeout')), 2000);
socket.once('connect', () => {
    clearTimeout(timer);
    socket.end();
});
socket.once('error', () => {
    clearTimeout(timer);
    process.exitCode = 1;
});
NODE
