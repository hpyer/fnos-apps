import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, buildHostsSnippet, renderConfig, validateRecord, validateSettings } from '../src/config.mjs';

test('renders DNS-only config without DHCP or system resolver', () => {
  const source = renderConfig({ ...DEFAULT_SETTINGS, listenAddresses: ['127.0.0.1', '192.168.1.10'], upstreams: ['1.1.1.1'], queryLogging: true }, [
    { type: 'exact', domain: 'nas.example.com', addresses: ['192.168.1.10'] },
    { type: 'suffix', domain: 'lan.example.com', addresses: ['192.168.1.20'] },
  ]);
  assert.match(source, /no-resolv/); assert.match(source, /bind-interfaces/); assert.match(source, /host-record=nas\.example\.com,192\.168\.1\.10/); assert.match(source, /address=\/lan\.example\.com\/192\.168\.1\.20/); assert.doesNotMatch(source, /dhcp-range|dhcp-host|dhcp-option/); assert.match(source, /log-queries/);
});

test('rejects config injection and invalid addresses', () => {
  assert.throws(() => validateSettings({ listenAddresses: ['127.0.0.1\nserver=8.8.8.8'] }), /监听地址/);
  assert.throws(() => validateRecord({ type: 'exact', domain: 'bad domain', addresses: ['1.1.1.1'] }), /域名/);
  assert.throws(() => validateRecord({ type: 'exact', domain: 'nas.example.com', addresses: ['1.1.1.1\nserver=x'] }), /记录地址/);
});

test('writes runtime pid file and keeps dnsmasq logs on stderr', () => {
  const source = renderConfig({ ...DEFAULT_SETTINGS }, [], { pidFile: '/data/runtime/dnsmasq.pid' });
  assert.match(source, /^pid-file=\/data\/runtime\/dnsmasq\.pid$/m);
  assert.match(source, /^log-facility=-$/m);
  assert.doesNotMatch(source, /^log-queries$/m);
});

test('hosts snippet contains exact names and suffix apexes only', () => {
  const snippet = buildHostsSnippet([
    { type: 'exact', domain: 'nas.home.arpa', addresses: ['192.168.1.20'] },
    { type: 'suffix', domain: 'lan.home.arpa', addresses: ['192.168.1.20', '192.168.1.21'] },
  ]);
  assert.equal(snippet, '192.168.1.20 lan.home.arpa\n192.168.1.20 nas.home.arpa\n192.168.1.21 lan.home.arpa\n');
  assert.doesNotMatch(snippet, /\*/);
  assert.equal(buildHostsSnippet([]), '');
});
