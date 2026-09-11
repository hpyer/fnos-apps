import { spawn } from 'node:child_process';

// Arguments never pass through a shell. Capture bounded diagnostics, never the full environment.
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 600_000);
    const collect = chunk => { output = (output + chunk.toString()).slice(-8192); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${command.split('/').pop()} 执行失败 (${code})：${redact(output)}`));
    });
  });
}
export function redact(text) {
  return String(text).replace(/([?&#](?:token|key|access_token)=)[^\s&#]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|npm_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
}
