import { spawn } from 'node:child_process';

export function command(binary, args, { timeout = 20000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    const collect = data => { output = (output + data.toString()).slice(-32768); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(Error('命令执行超时'));
      else if (code !== 0) reject(Error(output.trim() || `命令退出状态 ${code}`));
      else resolve(output.trim());
    });
  });
}
