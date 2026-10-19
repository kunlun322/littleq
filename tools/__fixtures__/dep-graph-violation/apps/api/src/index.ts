// 桶入口。夹具里它存在的唯一目的，是让「受控入口」与「桶入口」在文件系统上是两个不同的面：
// apps/web 只被允许导入 @littleq/api/server（见 apps/api/src/server.ts），
// 导入 @littleq/api 就是这个文件 —— 它会把整个 apps/api 的导出面（含只在服务端成立的
// 处理器与其依赖）拖进调用方的图里，Next 的客户端 chunk 因此有可能引用到服务端模块。
//
// 本文件自身不含违规：违规记在**导入方**（apps/web）身上。
export const apiBarrelFixture = { unit: 'apps/api', entry: 'barrel' };
