/**
 * `TurnProviderClient` 的真实实现：服务端 `fetch` 打 QCA Forward（§4.3：不引入 AI SDK）。
 *
 * ## 为什么是全局 `fetch` 而不是一个 SDK
 *
 * §0.2 的硬约束是「新增第三方生产依赖必须为 **0**」。Node 18+ 自带 `fetch`，它够用；
 * 一个 provider SDK 会带来一条进生产闭包、进 SBOM、进 license 门禁的新边，而它多给的
 * 东西（重试、流式解析、类型）在这个面上分别由 §5.3 的三段式外呼、`ProviderEventBatch`
 * 的一次有界拉取、和本文件的严格解析覆盖掉了。
 *
 * ## 一个方法 = 一次外部操作 = 一个幂等键
 *
 * `externalOperationKey` 由用例在外呼**之前**就落库（`task_private.operation_journal`，
 * `intent:'SENT'`），这里把它作为幂等头带出去。于是「回执丢了、重放同一个 key」不会在
 * provider 侧产生第二次计费动作 —— 这正是 §11.2 第 4 项负对照要的性质，而它只有在客户端
 * 真的把 key 传下去时才成立。
 *
 * ## 预算：客户端必须**先于**请求预算结束
 *
 * `budgetMs` 由用例给（外呼片段的窗口，短于 8 s 的请求预算）。这里用
 * `AbortSignal.any([调用方的 signal, AbortSignal.timeout(budgetMs)])`：前者是整个 HTTP
 * 请求的生命周期，后者是这一片外呼自己的窗口。本实现**不**自己 `setTimeout` 续命。
 *
 * ## 🚨 中止/超时错误一律原样抛出（不要包）
 *
 * `mapExternalFailure`（`packages/application/src/usecases/pump.ts:1454`）是按
 * **`error.name`** 分类的：`TimeoutError` / `AbortError` ⇒ `TASK_TIMEOUT`（**不可重试**），
 * 其余一切 ⇒ `QCA_UNREACHABLE`（**可重试**，上限 2，指数退避）。所以把一次超时包成
 * 普通 `Error` 不是"损失一点信息"，而是把一个**不该再试**的失败变成一个**会再打一次
 * provider**的失败 —— 第二次是付费动作。因此 `await fetch(...)` 的 rejection 原样穿透。
 *
 * ## 非 2xx 的错误消息里**只有状态码**
 *
 * provider 的响应体可能回显 prompt 片段、账号标识或计费信息，而这条消息最终会进
 * `DomainError` 的 `messageKey` 上下文与日志。所以这里只留状态码与操作名。
 *
 * ## ⚠️ 两处如实申报（交付评论里也写了）
 *
 * 1. **本文件的线上报文形状未经真实 QCA 服务验证。** §0.3 已把「真实 QCA 集成证据」
 *    记为**未取得**，§6.4 与 R66 裁定禁止任何计费动作，所以本轮不打真实云端。下面的
 *    `Forward*` 形状就是**本实现与它对端之间的约定**，验收测试里的本地替身按同一份约定
 *    应答。这不等于"伪造真实 AI 产出"：替身在测试里是被点名的替身，而真实云端证据
 *    明确记为未取得。
 * 2. **客户端绑定的是**一个**owner 的凭据。** `createSession` 的入参里没有 owner，
 *    而 BYO 凭据在存储里是按 owner 分行的（`SecretAdmin.read(ref, purpose)`）。因此
 *    `tokenSource` 由组合根在启动时绑定到部署配置里那个 OWNER。按请求切换 owner 需要
 *    给 `TurnProviderClient` 加一个 owner 入参并改 pump 的调用点 —— 那是 application
 *    层的接口变更，不在 B1 的预算里，故申报为缺口而不是就地扩权。
 */
import type {
  ProviderEventBatch,
  ProviderSessionHandle,
  TurnProviderClient,
} from '@littleq/application';
import { DomainError } from '@littleq/domain';

/** 幂等键的头名。对端按它去重同一个 `externalOperationKey` 的重复请求。 */
export const EXTERNAL_OPERATION_KEY_HEADER = 'Idempotency-Key';

/** 一次外呼的 JSON 解析失败 ⇒ 与"对端不可达"同一类（可重试），不是超时。 */
const PROVIDER_PAYLOAD_LABEL = 'TurnProviderClient.response';

export interface ForwardSessionPayload {
  readonly id: string;
  readonly identity_id: string;
  readonly template_id: string;
  readonly environment_id: string;
  readonly template_version?: string | null;
}

export interface ForwardEventPayload {
  readonly id: string;
  readonly type: string;
  readonly text?: string | null;
  readonly file?: { readonly path: string; readonly data_base64: string } | null;
}

export interface ForwardEventPagePayload {
  readonly items: readonly ForwardEventPayload[];
  readonly next_cursor?: string | null;
  readonly turn_complete?: boolean;
}

export interface TurnProviderClientOptions {
  /** Forward 的基址，例如 `https://api.qoder.cloud`。末尾斜杠会被规范化掉。 */
  readonly baseUrl: string;
  readonly identityId: string;
  readonly templateId: string;
  readonly environmentId: string;
  /**
   * 每次外呼**重新取**一次凭据，不在客户端里缓存。
   *
   * 缓存一份 token 会让 `:rotate` 之后的旧值继续被用 —— 而轮换的全部意义就是让旧值
   * 立刻失效。取一次的成本是一次本地解密，远小于外呼本身。
   */
  readonly tokenSource: () => Promise<string>;
  /** 组合根的时钟只用于日志/度量；外呼超时由 `budgetMs` 决定，不读时钟。 */
  readonly now?: () => number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new DomainError('QCA_UNREACHABLE', `${PROVIDER_PAYLOAD_LABEL}.${label}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function toHandle(payload: unknown): ProviderSessionHandle {
  if (typeof payload !== 'object' || payload === null) {
    throw new DomainError('QCA_UNREACHABLE', `${PROVIDER_PAYLOAD_LABEL}.session`);
  }
  const raw = payload as Partial<ForwardSessionPayload>;
  return {
    sessionId: requireString(raw.id, 'id'),
    identityId: requireString(raw.identity_id, 'identity_id'),
    templateId: requireString(raw.template_id, 'template_id'),
    environmentId: requireString(raw.environment_id, 'environment_id'),
    templateVersion: optionalString(raw.template_version),
  };
}

/**
 * 把 Forward 的事件映射成 `ProviderTurnEvent` 的三个分支。
 *
 * `OTHER` 是**显式**的第三支而不是"丢掉"：工具调用、思考、心跳都属于它。显式建模的理由
 * 是"看见了但决定不用"与"根本没看见"在代码里长得一样，而前者才让 `safePayload` 的
 * 白名单有对照物（§5.2）。
 *
 * 正文只认 `agent.message`：`user.message` 是学生自己发出去的那一句，把它当成模型产出
 * 收进包络等于让学生自己写 `index.html` 而绕过生成路径。
 */
function toTurnEvent(payload: ForwardEventPayload): ProviderEventBatch['items'][number] {
  const externalId = requireString(payload.id, 'items[].id');
  const file = payload.file;
  if (file !== undefined && file !== null) {
    return {
      externalId,
      kind: 'FILE',
      path: requireString(file.path, 'items[].file.path'),
      bytes: new Uint8Array(Buffer.from(file.data_base64, 'base64')),
    };
  }
  if (payload.type === 'agent.message' && typeof payload.text === 'string') {
    return { externalId, kind: 'TEXT', text: payload.text };
  }
  return { externalId, kind: 'OTHER' };
}

export function createTurnProviderClient(options: TurnProviderClientOptions): TurnProviderClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function call<T>(input: {
    readonly path: string;
    readonly method: 'POST' | 'GET';
    readonly body: unknown;
    readonly externalOperationKey: string | null;
    readonly budgetMs: number;
    readonly abortSignal: AbortSignal;
  }): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${await options.tokenSource()}`,
    };
    if (input.externalOperationKey !== null)
      headers[EXTERNAL_OPERATION_KEY_HEADER] = input.externalOperationKey;
    const init: RequestInit = { method: input.method, headers };
    if (input.body !== null) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(input.body);
    }
    // 两个信号合成一个：调用方的是整个 HTTP 请求的生命周期，`timeout` 的是这一片外呼。
    init.signal = AbortSignal.any([input.abortSignal, AbortSignal.timeout(input.budgetMs)]);

    // rejection 原样穿透（见文件头：包一层就会把 TASK_TIMEOUT 变成可重试的 QCA_UNREACHABLE）。
    const response = await fetch(`${baseUrl}${input.path}`, init);
    if (!response.ok) {
      throw new Error(`provider ${input.method} ${input.path} responded ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    async createSession({ externalOperationKey, budgetMs, abortSignal }) {
      const payload = await call<unknown>({
        path: '/v1/forward/sessions',
        method: 'POST',
        body: {
          identity_id: options.identityId,
          template_id: options.templateId,
          environment_id: options.environmentId,
        },
        externalOperationKey,
        budgetMs,
        abortSignal,
      });
      return toHandle(payload);
    },

    async sendUserMessage({ session, body, externalOperationKey, budgetMs, abortSignal }) {
      await call<unknown>({
        path: `/v1/forward/sessions/${encodeURIComponent(session.sessionId)}/events`,
        method: 'POST',
        // base64 而不是直接嵌字符串：prompt 是任意 UTF-8，而 JSON 里的控制字符与代理对
        // 一旦经过中间层重编码就可能变形，摘要会对不上 `input_ref.sha256`。
        body: {
          events: [
            {
              type: 'user.message',
              content: [{ type: 'text', text: Buffer.from(body).toString('base64') }],
            },
          ],
          content_encoding: 'base64',
        },
        externalOperationKey,
        budgetMs,
        abortSignal,
      });
    },

    async listEvents({ session, cursor, budgetMs, abortSignal }) {
      const query = new URLSearchParams();
      if (cursor !== null) query.set('page', cursor);
      query.set('order', 'asc');
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      const page = await call<ForwardEventPagePayload>({
        path: `/v1/forward/sessions/${encodeURIComponent(session.sessionId)}/events${suffix}`,
        method: 'GET',
        body: null,
        externalOperationKey: null,
        budgetMs,
        abortSignal,
      });
      const items = Array.isArray(page?.items) ? page.items : [];
      return {
        items: items.map(toTurnEvent),
        nextCursor: optionalString(page?.next_cursor) ?? null,
        turnComplete: page?.turn_complete === true,
      };
    },

    async interrupt({ session, externalOperationKey, budgetMs, abortSignal }) {
      await call<unknown>({
        path: `/v1/forward/sessions/${encodeURIComponent(session.sessionId)}/interrupts`,
        method: 'POST',
        body: {},
        externalOperationKey,
        budgetMs,
        abortSignal,
      });
    },
  };
}
