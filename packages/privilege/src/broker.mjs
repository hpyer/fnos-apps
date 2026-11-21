import { spawn } from 'node:child_process';
import { chmod, stat } from 'node:fs/promises';

export class PrivilegeError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'PrivilegeError';
    this.status = status;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Common fnOS privilege transport. Applications still own the helper scripts
 * and must keep their operation and path validation application-specific.
 */
export class PrivilegeBroker {
  constructor({ helperDir, run, redact = value => String(value ?? ''), getSecrets = () => [], spawnProcess = spawn, statFile = stat, chmodFile = chmod } = {}) {
    if (typeof helperDir !== 'string' || !helperDir) throw new TypeError('helperDir is required');
    if (typeof run !== 'function') throw new TypeError('run is required');
    this.helperDir = helperDir;
    this.run = run;
    this.redact = redact;
    this.getSecrets = getSecrets;
    this.spawnProcess = spawnProcess;
    this.statFile = statFile;
    this.chmodFile = chmodFile;
  }

  async runAsLoginUser(helper, args, { password = '', user = '' } = {}) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(user || '')) {
      throw new PrivilegeError('无法识别当前登录的 fnOS 用户，请重新登录后重试', 401);
    }
    if (!password || password.length > 512) throw new PrivilegeError('管理员密码无效', 401);
    const inner = ['sudo', '-S', '-p', 'SUDOPASS:', '-u', 'root', '--', helper, ...args].map(shellQuote).join(' ');
    const suCommand = `su - ${shellQuote(user)} -c ${shellQuote(inner)}`;
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      let sentSuPassword = false;
      let sentSudoPassword = false;
      const child = this.spawnProcess('script', ['-q', '-e', '-f', '-c', suCommand, '/dev/null'], {
        env: { ...process.env, TERM: 'dumb' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.stdin.end(); } catch { /* already closed */ }
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new PrivilegeError('管理员授权超时，请重试', 403));
      }, 30000);
      const onData = chunk => {
        const text = chunk.toString();
        output = (output + text).slice(-8000);
        if (!sentSuPassword && /Password[:：]|密码[:：]/.test(text) && !/SUDOPASS:/.test(text)) {
          sentSuPassword = true;
          child.stdin.write(`${password}\n`);
        }
        if (!sentSudoPassword && sentSuPassword && /SUDOPASS:|password for|\[sudo\]|密码[:：]/.test(text)) {
          sentSudoPassword = true;
          child.stdin.write(`${password}\n`);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', error => {
        if (error.code === 'ENOENT') finish(new PrivilegeError('系统缺少 script 命令，无法进行管理员授权', 500));
        else finish(new PrivilegeError(`管理员授权启动失败：${error.message}`, 500));
      });
      child.once('close', code => {
        if (code === 0) { finish(null, output.trim()); return; }
        let clean = output;
        if (password) clean = clean.split(password).join('***');
        clean = this.redact(clean, this.getSecrets()).trim();
        if (/Authentication failure|incorrect password|Sorry, try again|密码不正确/i.test(clean)) {
          finish(new PrivilegeError('管理员密码不正确，提权失败', 401));
        } else if (/not in the sudoers|不在 sudoers|sudoers file/i.test(clean)) {
          finish(new PrivilegeError('当前登录用户没有 sudo 权限，请检查 fnOS 管理员账号配置', 403));
        } else if (/a terminal is required|no tty|requiretty/i.test(clean)) {
          finish(new PrivilegeError('sudo 需要终端确认，无法在后台完成授权', 403));
        } else {
          finish(new PrivilegeError(clean.slice(0, 300) || `管理员授权失败（退出状态 ${code}）`, 403));
        }
      });
    });
  }

  async privilegedRun(helper, args, { password = '', user = '', allowPackageOwned = false, runAsLoginUser } = {}) {
    let info = null;
    try { info = await this.statFile(helper); } catch { info = null; }
    if (info && (info.mode & 0o022) !== 0) {
      try { await this.chmodFile(helper, 0o755); info = await this.statFile(helper); } catch { /* root-owned: cannot chmod */ }
    }
    const writableMask = allowPackageOwned ? 0o002 : 0o022;
    if (info && (info.mode & writableMask) !== 0) throw new PrivilegeError('系统 helper 不可被其他用户写入，已拒绝提权', 500);
    if (!allowPackageOwned && info && info.uid !== 0) throw new PrivilegeError('系统 helper 必须由 root 拥有，已拒绝提权', 500);
    if (process.getuid && process.getuid() === 0) return this.run(helper, args, { timeout: 15000 });
    if (password) {
      try { return await this.run('sudo', ['-n', helper, ...args], { timeout: 10000 }); }
      catch {
        return typeof runAsLoginUser === 'function'
          ? runAsLoginUser(helper, args, { password, user })
          : this.runAsLoginUser(helper, args, { password, user });
      }
    }
    try {
      return await this.run(helper, args, { timeout: 15000 });
    } catch (directError) {
      try {
        return await this.run('sudo', ['-n', helper, ...args], { timeout: 15000 });
      } catch (error) {
        const message = String(error.message || '');
        if (/incorrect password|密码/i.test(message)) throw new PrivilegeError('管理员密码不正确，提权失败', 401);
        if (/not in the sudoers|sudoers/i.test(message)) throw new PrivilegeError('当前系统不允许该用户通过 sudo 提权，请检查 fnOS 管理员账号配置', 403);
        throw new PrivilegeError(`无法执行系统 helper：${this.redact(message || directError.message, this.getSecrets())}`, 403);
      }
    }
  }
}
