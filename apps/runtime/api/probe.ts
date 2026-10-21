import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const ENV_NAMES = ['MAIN_SITE_ORIGIN', 'RUNTIME_ORIGIN'];

function derive(name: string) {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.length === 0) {
    return { name, present: false, origin: null };
  }
  let origin: string | null = null;
  try {
    origin = new URL(raw).origin;
  } catch {
    origin = null;
  }
  return {
    name,
    present: true,
    origin,
    sha256_12: createHash('sha256').update(raw).digest('hex').slice(0, 12),
  };
}

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  const body = {
    probe: 'lq-runtime-probe',
    kind: 'vercel-node-function',
    nonce: randomUUID(),
    issuedAt: new Date().toISOString(),
    nodeVersion: process.version,
    env: ENV_NAMES.map(derive),
  };
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-lq-runtime-probe', '1');
  res.end(JSON.stringify(body));
}
