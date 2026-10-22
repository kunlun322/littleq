/**
 * 登录页（ZLQ-232 四步闭环的第 1 步）。
 *
 * 页面本体是服务端组件，只做结构与文案；真正发请求的是 `_components/login-form.tsx`
 * 那个客户端组件。这么分是为了让**口令输入框不进服务端渲染路径**，也让这一页在
 * 没有会话时可以被静态预渲染。
 *
 * ⚠️ 「首个用户设密码」这一条**不由本页解决**：口令的初始化只能走后端那条受控的
 * 交互式命令（不进命令行、脚本、附件、评论、截图），所以在用户亲手设过密码之前，
 * 本页能证明的是「登录入口是真的、失败会如实报错」，**不是**「用户已经能登录」。
 */
import type { Metadata } from 'next';

import { LoginForm } from '../_components/login-form';
import { LOGIN_HEADING, LOGIN_LEAD } from '../../src/site-content';

export const metadata: Metadata = {
  title: '登录',
  description: '用学生账号登录 LittleQ，进入小网页创作工作台。',
};

export default function LoginPage() {
  return (
    <section className="lq-section" aria-labelledby="login-title">
      <div className="lq-container lq-narrow">
        <h1 id="login-title" className="lq-section-title">
          {LOGIN_HEADING}
        </h1>
        <p className="lq-section-lead">{LOGIN_LEAD}</p>

        <div className="lq-panel">
          <LoginForm />
        </div>
      </div>
    </section>
  );
}
