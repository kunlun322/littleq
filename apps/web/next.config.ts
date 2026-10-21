/**
 * ZLQ-219 探针分支：服务构建形态。
 *
 * 相对 `main` 的**唯一** delta 是移除静态导出：
 * - 去掉 `output: 'export'`（与设计 §6.1 第 1 条一致：服务构建必须能跑 API route）；
 * - 去掉仅对导出有意义的 `images.unoptimized`。
 *
 * `trailingSlash` / `transpilePackages` / `reactStrictMode` 保持不变，让法务页路径
 * （`/source-and-license/`）与 workspace 包消费方式与原形态一致。
 * 本文件只存在于 `probe/zlq-219-service-build` 分支，不进入 `main`。
 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  trailingSlash: true,
  transpilePackages: ['@littleq/design-system'],
  reactStrictMode: true,
};

export default nextConfig;
