import './build.mjs';

process.argv.push('--dev');
await import('../../dist/nginx-for-fnos/app/main.mjs');
