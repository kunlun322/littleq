// 故意违规 3 与 4（见 ../../../README.md）。请勿修复：这两行导入是控制用例的断言对象。
import { db } from '../../infra/src/db';
import { pgDriver } from './drivers/pg-driver';

export const violationFixture = { db, pgDriver };
