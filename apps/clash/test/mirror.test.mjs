import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mirrorGithubUrl, normalizeMirror, unmirrorGithubUrl } from '../src/mirror.mjs';

test('GitHub 加速地址只改写 GitHub 域名并保留原始路径', () => {
  const mirror = 'https://ghfast.top';
  assert.equal(normalizeMirror(mirror), 'https://ghfast.top/');
  assert.equal(
    mirrorGithubUrl('https://github.com/MetaCubeX/mihomo/releases/download/v1/a.gz', mirror),
    'https://ghfast.top/https://github.com/MetaCubeX/mihomo/releases/download/v1/a.gz',
  );
  assert.equal(
    mirrorGithubUrl('https://raw.githubusercontent.com/a/b/main/c.yaml', mirror),
    'https://ghfast.top/https://raw.githubusercontent.com/a/b/main/c.yaml',
  );
  assert.equal(mirrorGithubUrl('https://example.com/a', mirror), 'https://example.com/a');
  assert.equal(mirrorGithubUrl('https://ghfast.top/https://github.com/a/b', mirror), 'https://ghfast.top/https://github.com/a/b');
  assert.equal(unmirrorGithubUrl('https://ghfast.top/https://github.com/a/b', mirror), 'https://github.com/a/b');
  assert.equal(mirrorGithubUrl('file:///etc/passwd', mirror), 'file:///etc/passwd');
});
