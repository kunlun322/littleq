/**
 * 实体与聚合根（附录 A §6.1）。
 *
 * 各模块按 §6.3 的表分组一一对应：`account`↔`users`、`group`↔`groups/group_members`、
 * `project`↔`projects/project_versions`、`work`↔`works/publications`、
 * `task`↔`ai_tasks/task_events`、`usage`↔`usage_*`、`teaching`↔`courses/lessons/
 * assignments/submissions/gradings`、`reward`↔`reward_profiles/achievements/
 * achievement_unlocks/likes`、`audit`↔`audit_logs`。
 *
 * 三条贯穿所有实体的规则：
 * 1. **构造即校验**：每个 `create*` 都在返回前跑完全部不变量，因此一个类型正确的
 *    实体值不可能处于非法状态；调用方不需要（也不应该）在读取时再判定一遍。
 * 2. **不可变更新**：所有变更函数返回新对象并推进 `revision`，从不原地修改。
 *    这让 §6.4 要求的「以 revision CAS 保存结果」在 application 层可以直接落地。
 * 3. **平台无关**：实体层不读时钟、不读环境变量、不做 IO。所有"现在几点"都以
 *    参数传入，因此同一组输入在 macOS 与 ubuntu 上给出逐字节相同的结果
 *    （附录 A G6，OpenAPI 快照的可复现性依赖这一点）。
 */

export * from './account.js';
export * from './group.js';
export * from './project.js';
export * from './work.js';
export * from './task.js';
export * from './usage.js';
export * from './teaching.js';
export * from './reward.js';
export * from './audit.js';
