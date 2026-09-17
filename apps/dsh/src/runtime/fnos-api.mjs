import http from 'node:http';

const SOCKET = '/var/run/trim_open_gateway_apiscope.socket';
const APP = 'dsh-for-fnos';

export function callFnOS(environment, req, data = {}) {
  const token = environment.TRIM_API_TOKEN;
  if (!token) throw new Error('飞牛开放 API 凭据不可用');
  const payload = JSON.stringify({ reqId: String(Date.now()), req, appName: APP, data });
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: SOCKET,
      path: '/api/v1/trimapp',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        authorization: `Bearer ${token}`,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || result.code !== 0) return reject(new Error(result.msg || '飞牛开放 API 调用失败'));
          resolve(result.data);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(8_000, () => request.destroy(new Error('飞牛开放 API 响应超时')));
    request.end(payload);
  });
}

export async function userAccessibleFolders(environment, uid) {
  const result = await callFnOS(environment, 'trim.file.listUserAccess', { uid: String(uid) });
  return Array.isArray(result?.paths) ? result.paths : [];
}
