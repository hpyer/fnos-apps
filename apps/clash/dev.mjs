import './build.mjs';

process.argv.push('--dev');
await import('../../dist/clash-for-fnos/app/main.mjs');
