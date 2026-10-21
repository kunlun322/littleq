import { createHash, randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MARKER = 'LQ_SVC_PROBE_MARKER';

function markerEvidence() {
  const raw = process.env[MARKER];
  if (typeof raw !== 'string' || raw.length === 0) {
    return { name: MARKER, present: false, sha256_12: null };
  }
  return {
    name: MARKER,
    present: true,
    sha256_12: createHash('sha256').update(raw).digest('hex').slice(0, 12),
  };
}

export function GET() {
  return Response.json(
    {
      probe: 'lq-svc-probe',
      kind: 'next-app-router-route-handler',
      declaredRuntime: 'nodejs',
      nodeVersion: process.version,
      nonce: randomUUID(),
      issuedAt: new Date().toISOString(),
      env: markerEvidence(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
