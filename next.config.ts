import type { NextConfig } from 'next';

const config: NextConfig = {
  // standalone：容器/虚拟机可直接 `node server.js` 运行；Vercel 会忽略该选项
  output: 'standalone',
  // PGlite 带 WASM 文件，不要被打包
  serverExternalPackages: ['@electric-sql/pglite'],
  typescript: { ignoreBuildErrors: false },
  devIndicators: false,
};

export default config;
