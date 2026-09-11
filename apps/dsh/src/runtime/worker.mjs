// A parent-owned IPC channel prevents orphan DSH processes if the manager
// crashes. The detached child has its own process group, so one signal also
// reaches plugin subprocesses started by DSH.
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 8000).unref();
}
child.once('error', () => process.exit(1));
child.once('exit', code => {
  // Also reap descendants that outlive the direct DSH process.
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  process.exit(stopping ? 0 : (code ?? 1));
});
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
