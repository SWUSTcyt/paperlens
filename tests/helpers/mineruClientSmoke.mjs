import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { MineruClient } from '../../src/mineru/client.ts';

const configPath = resolve(requiredOption('config'));
const config = await readFile(configPath, 'utf8');
const token = config.match(/^token\s*=\s*"([A-Za-z0-9_-]{32,512})"\s*$/m)?.[1];
const port = Number(config.match(/^port\s*=\s*(\d+)\s*$/m)?.[1] ?? 17860);
if (!token) throw new Error('测试配置没有合法 token');

const health = await new MineruClient({ port, accessToken: token }).testConnection();
process.stdout.write(`本地客户端烟测通过：${health.service} ${health.serviceVersion} / MinerU ${health.engine.version}\n`);

function requiredOption(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`缺少 --${name}=...`);
  return value;
}
