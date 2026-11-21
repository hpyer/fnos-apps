import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DnsmasqManager } from './manager.mjs';
import { serve } from './server.mjs';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = process.env.TRIM_PKGVAR || path.resolve(appRoot, '../.local/var');
const socket = process.env.TRIM_APPDEST ? path.join(process.env.TRIM_APPDEST, 'app.sock') : '';
const devPort = socket ? undefined : Number(process.env.PORT || 3084);
const manager = new DnsmasqManager(dataRoot, { appRoot, binary: process.env.DNSMASQ_BINARY || path.join(appRoot, 'bin/dnsmasq') });
await manager.init();
if (manager.settings.autoStart) manager.start().catch(error => { manager.lastError = error.message; });
const web = await serve(manager, { assets: new URL('./web/', import.meta.url), socket, devPort });
const shutdown = async () => { await manager.close(); await web.close(); process.exit(0); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
