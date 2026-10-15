// 故意违规 7（见 ../../../README.md）。请勿修复。
// packages/application 在 ZLQ-153 §1.3 的目录清单里还不存在，但 §5.4(4) 已经点名禁止它导入
// drivers/*。规则按路径预先武装，这里证明该包一旦落地就立刻被约束，而不是等到有人补规则。
import { pgDriver } from '../../domain/src/drivers/pg-driver';

export const applicationViolationFixture = { pgDriver };
