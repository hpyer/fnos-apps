import './build.mjs';

process.argv.push('--dev');
await import('../../dist/ffmpeg-for-fnos/app/main.mjs');
