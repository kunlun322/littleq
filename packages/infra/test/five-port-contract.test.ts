/**
 * 能力 `five-port-contract` —— `tools/unit-readiness-contract.json` 给 `packages/infra` 点名的
 * 黑盒证明（ZLQ-194 §6.2 的五个端口、ZLQ-203 §1）。
 *
 * ## 这个测试断言的是什么，不是什么
 * **是**：端口契约的**形状**（恰好五个端口文件、每个端口的方法名集合、§14 六项不变量的名字、
 * 五个值类型确实从本包导出、grant 机制不在端口计数里、`RuntimePublisher` 上「永久公开发布 /
 * slug / 回滚」三个能力**不存在**），以及**类型装不下什么**（`ObjectRef` 的语法里没有 `:`，
 * 所以一个 provider URL 根本无法通过 `parseObjectRef`；端口源码里没有任何 URL/摘要字面量）。
 *
 * **不是**：端口**实现**的行为正确性。那九条能力各自有测试；对**真实** Vercel Blob private
 * 链路的未授权/过期拒绝更是本单做不到、也不声称做到的事（留给 D5/D6）。
 *
 * ## 为什么运行时断言落在替身上
 * TypeScript 的接口在运行时被擦除，`implements` 只能证明**方法名对得上**（编译期），证明不了
 * 「端口在运行时确实是一个有五组方法的对象」。所以这里对每个端口取一个可注入的内存替身，
 * 逐个断言方法是 `function`；替身与端口的一致性由 `implements` 在 `pnpm typecheck` 里钉住，
 * 两者合起来才是完整的契约。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACT_MAX_BYTES,
  HEALTH_STATUSES,
  InMemoryDatabaseAdapter,
  InMemoryObjectStore,
  InMemoryRuntimePublisher,
  InMemoryTaskRepository,
  MASTER_KEY_ENV_VAR,
  OBJECT_STORE_INVARIANTS,
  RUNTIME_PREVIEW_AUDIENCE,
  SECRET_PURPOSES,
  SensitiveUrl,
  isHealthStatus,
  isObjectRef,
  markSensitiveUrl,
  parseObjectRef,
} from '../src/index.js';
import { ObjectReadGrantService } from '../src/grant/object-read-grant.js';
import { InMemoryGrantRecordStore } from '../src/grant/memory-records.js';
import type { DatabaseAdapter } from '../src/ports/database-adapter.js';
import type { ObjectStore } from '../src/ports/object-store.js';
import type { RuntimePublisher } from '../src/ports/runtime-publisher.js';
import type { SecretStore } from '../src/ports/secret-store.js';
import type { TaskRepository } from '../src/ports/task-repository.js';
import { SecretCipher, parseMasterKey } from '../src/secret-store/cipher.js';
import { InMemorySecretRecordStore } from '../src/secret-store/memory-records.js';
import { EncryptedSecretStore } from '../src/secret-store/store.js';
import { streamFromBytes } from '../src/object-store/budget.js';

import { describe, expect, it } from 'vitest';

import {
  TEST_MASTER_KEY_HEX,
  at,
  bytes,
  collect,
  countOccurrences,
  sha256Of,
  stripComments,
} from './support.js';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** 端口源码（剥掉注释）。契约里承载的是规则名，注释里的说明文字不参与判定。 */
function code(relative: string): string {
  return stripComments(source(relative));
}

interface PortProbe {
  readonly port: string;
  readonly file: string;
  readonly methods: readonly string[];
  readonly instance: object;
}

const objectStore: ObjectStore = new InMemoryObjectStore({ now: () => new Date(0) });
const secretStore: SecretStore = new EncryptedSecretStore({
  cipher: new SecretCipher(parseMasterKey(TEST_MASTER_KEY_HEX)),
  records: new InMemorySecretRecordStore(),
  now: () => at(0),
});
const grantService = new ObjectReadGrantService({
  store: objectStore,
  records: new InMemoryGrantRecordStore(),
  url: { origin: 'https://littleq.test', basePath: '/internal/object-read' },
  now: () => at(0),
});

const FIVE_PORTS: readonly PortProbe[] = [
  {
    port: 'DatabaseAdapter',
    file: '../src/ports/database-adapter.ts',
    methods: ['transaction', 'migrate', 'health', 'close'],
    instance: new InMemoryDatabaseAdapter() satisfies DatabaseAdapter,
  },
  {
    port: 'TaskRepository',
    file: '../src/ports/task-repository.ts',
    methods: [
      'claim',
      'renewLease',
      'reacquireLease',
      'requeueOnLeaseExpiry',
      'releaseLease',
      'save',
      'appendEvent',
      'scheduleNextRun',
      'findById',
    ],
    instance: new InMemoryTaskRepository() satisfies TaskRepository,
  },
  {
    port: 'ObjectStore',
    file: '../src/ports/object-store.ts',
    methods: ['putImmutable', 'getPrivate', 'head', 'deletePrefix', 'health'],
    instance: objectStore,
  },
  {
    port: 'SecretStore',
    file: '../src/ports/secret-store.ts',
    methods: ['set', 'rotate', 'revoke', 'read', 'metadata'],
    instance: secretStore,
  },
  {
    port: 'RuntimePublisher',
    file: '../src/ports/runtime-publisher.ts',
    methods: ['publishPreview', 'revokePreview', 'health'],
    instance: new InMemoryRuntimePublisher({ grants: grantService }) satisfies RuntimePublisher,
  },
];

/** 一个类实例上的**方法**名（不含 getter、不含 `constructor`）。 */
function methodNames(instance: object): string[] {
  const names: string[] = [];
  let proto: object | null = Object.getPrototypeOf(instance) as object | null;
  while (proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (typeof descriptor?.value === 'function') names.push(name);
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return [...new Set(names)].sort();
}

describe('five-port-contract：端口目录恰好五个，grant 不是第六个', () => {
  it('src/ports/ 下的文件名集合被逐个点名', () => {
    const files = readdirSync(fileURLToPath(new URL('../src/ports', import.meta.url))).sort();
    expect(files).toEqual([
      'database-adapter.ts',
      'object-store.ts',
      'runtime-publisher.ts',
      'secret-store.ts',
      'task-repository.ts',
    ]);
    expect(files).toHaveLength(5);
    expect(FIVE_PORTS.map((probe) => probe.port)).toEqual([
      'DatabaseAdapter',
      'TaskRepository',
      'ObjectStore',
      'SecretStore',
      'RuntimePublisher',
    ]);
  });

  it('grant 机制存在，但它在 ports/ 之外（裁定一 §2：应用语义，消费 ObjectStore）', () => {
    expect(
      readFileSync(
        fileURLToPath(new URL('../src/grant/object-read-grant.ts', import.meta.url)),
        'utf8',
      ).length,
    ).toBeGreaterThan(0);
    const files = readdirSync(fileURLToPath(new URL('../src/ports', import.meta.url)));
    expect(files.some((file) => file.includes('grant'))).toBe(false);
    // grant 服务消费 ObjectStore：它不是与五端口并列的第六个 provider port。
    expect(typeof grantService.open).toBe('function');
    expect(typeof grantService.issue).toBe('function');
    expect(methodNames(grantService)).not.toContain('putImmutable');
  });
});

describe('five-port-contract：每个端口的方法面', () => {
  for (const probe of FIVE_PORTS) {
    it(`${probe.port} 声明且实现了它承诺的每一个方法`, () => {
      const portCode = code(probe.file);
      const instance = probe.instance as Record<string, unknown>;
      for (const method of probe.methods) {
        // 源码侧：接口里确实声明了它（`name(` 或泛型形参 `name<`）。
        const declared =
          countOccurrences(portCode, `${method}(`) + countOccurrences(portCode, `${method}<`);
        expect(declared, `${probe.port}.${method} 未在端口源码里声明`).toBeGreaterThan(0);
        // 运行时侧：替身上它真的是一个函数。
        expect(typeof instance[method], `${probe.port}.${method} 在替身上不是函数`).toBe(
          'function',
        );
      }
    });
  }

  it('RuntimePublisher 上没有永久公开发布 / slug / 回滚 —— 缺失本身就是契约', () => {
    // 正向对照①：剥离器真的在工作。这个文件的头注释里**逐字写着** slug 这个词（它在解释
    // 「slug 分配现在不存在」），所以「原文里有、剥完之后没有」才是剥离生效的证据；
    // 一个把整份文件吃空的剥离器同样会让下面的 0 命中通过，那正是假绿。
    const raw = source('../src/ports/runtime-publisher.ts');
    const stripped = stripComments(raw);
    expect(stripped.length).toBeLessThan(raw.length);
    expect(countOccurrences(raw, 'slug')).toBeGreaterThan(0);
    expect(countOccurrences(stripped, 'slug')).toBe(0);
    // 正向对照②：剥完之后**该在的还在**，否则「0 命中」只是把一切都删掉了。
    expect(countOccurrences(stripped, 'publishPreview')).toBeGreaterThan(0);
    expect(countOccurrences(stripped, 'revokePreview')).toBeGreaterThan(0);

    for (const absent of ['publishPublic', 'publishPermanent', 'slug', 'assignSlug', 'rollback']) {
      expect(countOccurrences(stripped, absent), `${absent} 不该出现在端口契约里`).toBe(0);
    }
    // 运行时的同一件事：这个端口只有三个方法。
    expect(methodNames(new InMemoryRuntimePublisher({ grants: grantService }))).toEqual([
      'health',
      'publishPreview',
      'revokePreview',
    ]);
  });
});

describe('five-port-contract：ZLQ-194 §14 的六项未实证点被写成端口不变量', () => {
  it('OBJECT_STORE_INVARIANTS 逐字等于那六项', () => {
    expect(OBJECT_STORE_INVARIANTS).toEqual([
      'unauthorized-direct-read',
      'expired-url',
      'size-boundary-15mib',
      'concurrent-download',
      'chunked-artifact-sealing',
      'raw-signed-url-never-logged',
    ]);
    expect(OBJECT_STORE_INVARIANTS).toHaveLength(6);
  });

  it('15 MiB 上界是一个常量，不是散落在调用点里的魔数', () => {
    expect(ARTIFACT_MAX_BYTES).toBe(15 * 1024 * 1024);
    const portCode = code('../src/ports/object-store.ts');
    for (const invariant of OBJECT_STORE_INVARIANTS) {
      expect(
        countOccurrences(portCode, invariant),
        `${invariant} 未在端口源码里出现`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('five-port-contract：五个值类型确实从 packages/infra 导出', () => {
  it('ObjectRef 的语法装不下一个 URL（结构性保证，不靠调用方自觉）', () => {
    expect(isObjectRef('artifacts/0f/chunks/0-0e')).toBe(true);
    expect(isObjectRef(parseObjectRef('originals/p/v').toString())).toBe(true);
    for (const notARef of [
      'https://blob.vercel-storage.example/x?sig=abc',
      'http://localhost:3000/x',
      '//host/path',
      '/abs/path',
      '',
      'a/../../etc/passwd',
      'dir/',
    ]) {
      expect(isObjectRef(notARef), notARef).toBe(false);
      expect(() => parseObjectRef(notARef), notARef).toThrow('OBJECT_NOT_FOUND');
    }
  });

  it('SensitiveUrl 是一个运行时类，toString / toJSON 都只给脱敏形式', () => {
    expect(typeof SensitiveUrl).toBe('function');
    const url = markSensitiveUrl(
      'https://littleq.test/internal/object-read?grant=super-secret-token',
    );
    expect(url).toBeInstanceOf(SensitiveUrl);
    expect(url.toString()).not.toContain('super-secret-token');
    expect(JSON.stringify({ url })).not.toContain('super-secret-token');
    // reveal() 是拿到原文的唯一一条路，而且它确实给得出原文。
    expect(url.reveal()).toContain('super-secret-token');
    expect(() => SensitiveUrl.from('not a url')).toThrow('SENSITIVE_URL_INVALID');
    expect(() => SensitiveUrl.from('')).toThrow('SENSITIVE_URL_INVALID');
  });

  it('HealthResult 的键集合与状态取值域', () => {
    expect(HEALTH_STATUSES).toEqual(['ok', 'degraded', 'unavailable']);
    expect(isHealthStatus('ok')).toBe(true);
    expect(isHealthStatus('healthy')).toBe(false);
    return objectStore.health().then((health) => {
      expect(Object.keys(health).sort()).toEqual(['checkedAt', 'detail', 'latencyMs', 'status']);
      expect(isHealthStatus(health.status)).toBe(true);
      expect(health.detail).toBeNull();
    });
  });

  it('StoredObjectStream / StoredObjectMetadata 的键集合，取自一次真实读写的结果', async () => {
    const payload = bytes(96, 7);
    const ref = await objectStore.putImmutable({
      key: 'artifacts/five-port/probe',
      body: streamFromBytes(payload),
      declaredBytes: payload.byteLength,
      maxBytes: ARTIFACT_MAX_BYTES,
      sha256: sha256Of(payload),
      contentType: 'application/octet-stream',
      abortSignal: new AbortController().signal,
    });

    const metadata = await objectStore.head(ref);
    expect(metadata).not.toBeNull();
    if (metadata === null) return;
    expect(Object.keys(metadata).sort()).toEqual([
      'byteLength',
      'contentType',
      'createdAt',
      'etag',
      'ref',
      'sha256',
    ]);

    const stream = await objectStore.getPrivate({
      ref,
      maxBytes: ARTIFACT_MAX_BYTES,
      abortSignal: new AbortController().signal,
    });
    expect(Object.keys(stream).sort()).toEqual([
      'body',
      'byteLength',
      'contentType',
      'deliveredBytes',
      'range',
      'ref',
      'sha256',
    ]);
    expect(await collect(stream.body)).toEqual(payload);
    expect(stream.deliveredBytes()).toBe(payload.byteLength);
    // 两个类型里都**没有** url / downloadUrl 字段：provider URL 无处可放。
    expect(Object.keys(stream).some((key) => key.toLowerCase().includes('url'))).toBe(false);
    expect(Object.keys(metadata).some((key) => key.toLowerCase().includes('url'))).toBe(false);
  });
});

describe('five-port-contract：端口契约只承载规则名 / 能力名 / 状态名', () => {
  it('五个端口源码里没有任何 URL、签名或摘要字面量', () => {
    // 正向对照：扫描器本身有效。没有它，「0 命中」与「扫描器根本没跑」无法区分。
    expect(countOccurrences("const u = 'https://x.test/a?sig=1';", 'https://')).toBe(1);

    for (const probe of FIVE_PORTS) {
      const portCode = code(probe.file);
      for (const observable of ['https://', 'http://', '?sig=', 'Bearer ', '-----BEGIN']) {
        expect(countOccurrences(portCode, observable), `${probe.port} 里出现 ${observable}`).toBe(
          0,
        );
      }
      // 64 位小写十六进制（一个 sha256 摘要的形状）也不该被写死在契约里。
      expect(/[0-9a-f]{64}/.test(portCode), `${probe.port} 里写死了一个摘要`).toBe(false);
    }
  });

  it('SecretStore 的凭据面只承载**名字**，不承载值', () => {
    expect(MASTER_KEY_ENV_VAR).toBe('LITTLEQ_MASTER_KEY');
    expect(SECRET_PURPOSES).toEqual(['qca-call', 'bailian-call']);
    expect(RUNTIME_PREVIEW_AUDIENCE).toBe('runtime-preview');
    const portCode = code('../src/ports/secret-store.ts');
    // 端口源码里出现的是环境变量**名**，而不是任何值；64 位十六进制同样 0 命中。
    expect(countOccurrences(portCode, MASTER_KEY_ENV_VAR)).toBeGreaterThan(0);
    expect(/[0-9a-f]{64}/.test(portCode)).toBe(false);
  });
});
