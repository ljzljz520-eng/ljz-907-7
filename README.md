# 志愿者培训片库

一个可实际运行的志愿者培训管理系统：管理员通过 CSV 导入培训视频与考试提示、管理用户；志愿者登录后按**服务岗位**查看必看片，看完提交反馈；后台按岗位统计完成情况。

## 技术栈

- **Node.js + Express**（REST API + 会话登录）
- **真·SQLite 数据库**：[sql.js](https://github.com/sql-js/sql.js)（WASM 版 SQLite，无需本机编译），三张关系表，数据持久化到 `data/library.db`
- 密码 scrypt 加盐哈希，express-session 会话鉴权，角色分管理员/志愿者
- 原生 HTML/CSS/JS 单页前端（无构建步骤）

## 快速开始

```bash
npm install
npm start                 # http://localhost:3000
```

首次启动自动建表并写入演示数据。

| 角色 | 账号 | 密码 | 岗位 |
|---|---|---|---|
| 管理员 | `admin` | `admin123` | 管理 |
| 志愿者 | `zhangwei` | `vol123` | 导览服务 |
| 志愿者 | `lina` | `vol123` | 签到引导 |
| 志愿者 | `wangfang` | `vol123` | 应急救护 |
| 志愿者 | `liuyang` | `vol123` | 后勤保障 |

另附 4 名志愿者之外的示例文件：`samples/users.csv`、`samples/videos.csv`（首次启动自动导入 7 部影片）。

## 使用流程

1. **管理员登录** → “CSV 导入”页上传影片 CSV（含考试提示）与用户 CSV，页面可下载模板。
2. **志愿者登录** → 系统按其岗位列出必看片 = `适用岗位=本人岗位` 的专项片 **+** `适用岗位=通用` 的全员片；每部片下方展示考试提示。
3. 看完后点“标记已看完并提交反馈”（1–5 星评分 + 文字意见，可反复修改；完成状态不可逆）。
4. 管理员在“岗位完成统计”选择岗位，查看：总体完成率、每部片完成人数/完成率、每位志愿者进度条。

## CSV 格式

**影片**（表头支持中英文别名）：

```
编号,片名,适用岗位,视频地址,时长分钟,考试提示,简介
V001,志愿者通用礼仪,通用,https://example.com/v001.mp4,12,考点：三点微笑、服务忌语5句,全员必修
V003,展厅导览讲解技巧,导览服务,https://example.com/v003.mp4,20,考点：讲解动线与互动节奏,
```

- `编号` 是唯一键：重复导入时**更新**而不是报错；错误行逐行返回（行号 + 原因），不影响其他行。
- `适用岗位` 填 `通用` 表示所有岗位必看。
- 解析器支持字段内含逗号、换行、`""` 转义及 UTF-8 BOM（Excel 友好）。

**用户**：`用户名,密码,姓名,岗位,角色`。用户名重复则更新（密码列留空表示不改密码）；新用户必须带初始密码。

## 数据模型

```text
users    (id, username UNIQUE, password_hash, salt, real_name, position, role, created_at)
videos   (id, code UNIQUE, title, position, url, duration_minutes,
          exam_tips, description, active, created_at)
feedback (id, user_id→users, video_id→videos, watched, watched_at,
          rating(1-5), comment, created_at, updated_at, UNIQUE(user_id,video_id))
```

反馈表每人每片唯一一条记录（upsert），`watched=1` 即“已完成观看”，是岗位统计的口径。

## 主要 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` `/logout` `/api/auth/me` | 会话 |
| GET | `/api/my/videos` | 当前志愿者的必看片及完成状态 |
| POST | `/api/my/videos/:id/feedback` | 提交/更新观看反馈 |
| POST | `/api/admin/import/videos` `.../users` | CSV 导入（multipart 字段 `file`） |
| GET | `/api/admin/videos` `/users` `/positions` | 后台列表 |
| GET | `/api/admin/stats?position=导览服务` | 按岗位完成统计 |
| GET | `/api/admin/feedback?video_id=` | 反馈明细 |
| GET | `/api/admin/template/videos|users` | CSV 模板下载 |

## 测试

```bash
npm test          # test/e2e.sh：在临时数据库上启动服务并跑 14 项端到端断言
```

覆盖：鉴权拦截、岗位匹配（通用+专项）、跨岗位隔离、CSV 新增/更新/错误行/转义、反馈幂等与完成不可逆、岗位统计、越权访问。

## 配置

- `PORT`（默认 3000）
- `VLIB_DATA_DIR`：数据库与会话密钥目录（默认 `data/`）
