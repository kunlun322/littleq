// 本单元在夹具里只是**受控边的目标**，自身不含违规。
// 它是 apps/web 唯一被允许访问的那个窄面（ZLQ-194 §4.3：「apps/api 暴露一个 server-only
// 受控入口；形态 A 仍由 Fastify/NestJS bootstrap 调用同一处理器」）。
//
// 刻意零依赖：这样「apps/web 那几处违规确实来自越界引用」与「目标单元自己触发了出向禁止」
// 两种情况在输出里可以区分开 —— 与 packages/api-contract 在本夹具里的处理方式同理。
import 'server-only';

export const apiControlledEntryFixture = { unit: 'apps/api', entry: 'server' };
