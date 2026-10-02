import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(rootDir, 'src-devices', 'build');
const targetDir = join(rootDir, 'admin', 'dm-widgets');

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
await cp(join(sourceDir, 'customDevices.js'), join(targetDir, 'customDevices.js'));
await cp(join(sourceDir, 'assets'), join(targetDir, 'assets'), { recursive: true });
