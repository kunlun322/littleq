import { DomainError } from '../errors/domain-error.js';

/**
 * 字符串枚举值对象的工厂。
 *
 * `members` 的**声明顺序被保留并对外暴露**：它就是 OpenAPI `enum` 数组的顺序。
 * 快照规范化只对语义无序的集合排序，枚举数组属于语义有序（ZLQ-153 附录 A §4.1），
 * 因此这里的顺序是契约的一部分，改动它会产生快照 diff，正是我们想要的可见性。
 */
export type StringEnum<Member extends string> = {
  readonly members: readonly Member[];
  readonly is: (value: string) => value is Member;
  readonly parse: (value: string) => Member;
};

export function stringEnum<Member extends string>(
  name: string,
  members: readonly Member[],
): StringEnum<Member> {
  if (members.length === 0) throw new Error(`empty enum: ${name}`);
  const unique = new Set<string>(members);
  if (unique.size !== members.length) throw new Error(`duplicate enum member in ${name}`);
  return {
    members,
    is: (value: string): value is Member => unique.has(value),
    parse: (value: string): Member => {
      if (!unique.has(value)) throw DomainError.invalid(name);
      return value as Member;
    },
  };
}
