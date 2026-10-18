/**
 * 值对象的品牌标记。
 *
 * 领域值对象对外是不可透明的：`UserId` 不能由裸 `string` 直接赋值，必须过
 * `parseUserId()`。品牌只存在于类型层，运行时仍是普通字符串/数字，因此
 * 序列化、比较与快照都不需要额外适配。
 */
const VALUE_OBJECT_BRAND: unique symbol = Symbol('littleq.domain.valueObject');

export type ValueObjectBrand = typeof VALUE_OBJECT_BRAND;

export type Branded<Base, Name extends string> = Base & {
  readonly [VALUE_OBJECT_BRAND]: Name;
};

/** 把一个已经通过校验的原值提升为品牌类型；只允许在 parse 函数内部使用。 */
export function brand<Base, Name extends string>(value: Base): Branded<Base, Name> {
  return value as Branded<Base, Name>;
}
