import Link from 'next/link';
import { Duck } from '@/components/Duck';

export default function NotFound() {
  return (
    <main className="page container center">
      <Duck size={140} mood="sleep" className="duck-bob" />
      <h1>小鸭子找不到这个页面</h1>
      <p className="muted">可能链接写错了，或者作品已经收起来啦。</p>
      <Link href="/" className="btn primary">
        回到首页
      </Link>
    </main>
  );
}
