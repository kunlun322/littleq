// 违规 3 的导入目标。持有数据库连接，因此领域层不得反向依赖它。
export const db = { name: 'fixture-db' };
