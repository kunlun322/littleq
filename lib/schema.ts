export const SCHEMA: string[] = [
  `create table if not exists users (
    id text primary key,
    username text unique not null,
    nickname text not null,
    role text not null default 'student',      -- student | teacher
    age_band text not null default 'L2',       -- L1 小小鸭 / L2 勇敢鸭 / L3 探险鸭
    avatar text not null default '🐥',
    pass_hash text not null,
    created_by text,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists sessions (
    token text primary key,
    user_id text not null references users(id) on delete cascade,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists projects (
    id text primary key,
    owner_id text not null references users(id) on delete cascade,
    title text not null,
    work_type text not null default 'GAME',   -- GAME | TOOL | ANIMATION
    description text not null default '',
    html text not null default '',
    version_seq int not null default 0,
    slug text unique,
    visibility text not null default 'private', -- private | class | public
    published_at timestamptz,
    likes int not null default 0,
    views int not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists versions (
    project_id text not null references projects(id) on delete cascade,
    seq int not null,
    html text not null,
    note text not null default '',
    created_at timestamptz not null default now(),
    primary key (project_id, seq)
  )`,
  `create table if not exists messages (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    role text not null,                       -- user | assistant
    content text not null,
    version_seq int,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists messages_project_idx on messages(project_id, created_at)`,
  `create table if not exists likes (
    project_id text not null references projects(id) on delete cascade,
    user_id text not null references users(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (project_id, user_id)
  )`,
  `create table if not exists classes (
    id text primary key,
    owner_id text not null references users(id) on delete cascade,
    name text not null,
    join_code text unique not null,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists class_members (
    class_id text not null references classes(id) on delete cascade,
    user_id text not null references users(id) on delete cascade,
    joined_at timestamptz not null default now(),
    primary key (class_id, user_id)
  )`,
  `create table if not exists assignments (
    id text primary key,
    class_id text not null references classes(id) on delete cascade,
    title text not null,
    description text not null default '',
    due_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists submissions (
    id text primary key,
    assignment_id text not null references assignments(id) on delete cascade,
    student_id text not null references users(id) on delete cascade,
    project_id text not null references projects(id) on delete cascade,
    version_seq int not null,
    stars int,
    comment text,
    status text not null default 'submitted',  -- submitted | graded | redo
    submitted_at timestamptz not null default now(),
    graded_at timestamptz,
    unique (assignment_id, student_id)
  )`,
  // —— QCA（Qoder Cloud Agents · Forward）——
  // 程序自动创建的 Forward 资源 ID 缓存：environment / template / identity
  `create table if not exists qca_refs (
    key text primary key,
    value text not null,
    created_at timestamptz not null default now()
  )`,
  // 创作伙伴：每个作品一条 Forward 会话；agent_seen_seq = 这条会话已经“看过”的代码版本
  `alter table projects add column if not exists agent_session_id text`,
  `alter table projects add column if not exists agent_seen_seq int`,
  // 智能体作品：每次打开作品、每个观看者一条 Forward 会话
  `create table if not exists agent_chats (
    id text primary key,                         -- 父页面生成的会话键
    project_id text not null references projects(id) on delete cascade,
    viewer_id text,                              -- 未登录访客为空
    template_id text not null,
    forward_session_id text not null,
    turns int not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists agent_chats_project_idx on agent_chats(project_id, created_at)`,
];
