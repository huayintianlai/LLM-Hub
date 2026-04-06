# LLM-Hub 实施任务清单

> 基于新架构设计的实施计划
>
> 更新日期：2026-04-06

## Phase 1：最小可用原型（1-2 天）

**目标：验证直通模式可行性**

- [x] 创建 simple-passthrough-proxy.mjs
  - [x] 监听 :4105
  - [x] 接收 /responses 请求
  - [x] 使用完整路径转发到 quan2go（避免 URL 拼接歧义）
  - [x] 直接返回响应（不做任何转换）
- [x] 配置 Codex CLI 测试
- [x] 验证事件序列正确性
- [x] 确认直通模式可行

**备注：**
- 已提供 `scripts/acceptance-codex.sh` 进行真实 `codex exec` 验收。
- 在当前“Codex 内嵌运行 Codex CLI”的嵌套环境里，`codex exec -> http://127.0.0.1:*` 会在到达本地代理前返回 `502 Bad Gateway`，因此该项需要在用户自己的终端会话中复核；`curl` 与网关/代理的真实链路已验证通过。

## Phase 2：完整网关核心（3-4 天）

**目标：实现智能路由和双模式支持**

### 2.1 多端口监听和应用识别
- [x] 实现多端口监听（4105/4106/4107/4000）
- [x] 实现端口到应用名称的映射
- [x] 实现请求上下文（包含 app_name 和 app_port）

### 2.2 协议检测和上游能力
- [x] 实现请求协议检测（/responses vs /chat/completions）
- [x] 实现上游配置加载（YAML 格式）
- [x] 实现上游能力检测（细粒度）
  - [x] 检测端点支持（supports_responses, supports_chat_completions）
  - [x] 检测流式行为（requires_stream, always_streams）
  - [x] 检测响应格式（event_format）

### 2.3 路由决策
- [x] 实现路由决策逻辑（优先直通，备选转换）
- [x] 实现上游选择策略（最差里面挑最好的）
- [x] 实现负载均衡

### 2.4 直通模式
- [x] 实现直通模式请求转发
- [x] 实现 URL 构建（origin + full_path，避免拼接歧义）
- [x] 实现认证头处理
- [x] 实现流式响应转发

### 2.5 转换模式
- [x] 实现请求转换（Codex request → 上游 request）
  - [x] 基础字段转换（model, messages, stream）
  - [x] 特殊字段处理（tools, reasoning）
  - [x] 针对不同上游的适配
- [x] 实现响应转换（上游 response → Codex response）
  - [x] SSE 事件序列生成
  - [x] 事件顺序保证
  - [x] 特殊字段处理
- [x] 请求转换和响应转换独立实现

### 2.6 容灾和故障转移
- [x] 实现被动监控（基于请求结果）
- [x] 实现自适应熔断器（指数退避）
- [x] 实现故障转移逻辑
- [x] 实现渐进式恢复

## Phase 3：监控和统计（2-3 天）

**目标：完整的可观测性**

### 3.1 SQLite 数据库集成
- [x] 设计数据库 Schema（兼容 SQLite 和 PostgreSQL）
  - [x] requests 表（包含 app_port 字段）
  - [x] upstream_states 表
  - [x] 索引优化
- [x] 实现 SQLite 适配器
- [x] 实现数据库初始化脚本
- [x] 实现数据库迁移脚本

### 3.2 请求记录
- [x] 实现请求日志记录（异步写入）
- [x] 实现向上记录（上游消耗）
- [x] 实现向下拆分（项目级别，通过端口识别）
- [x] 实现成本计算
- [x] 实现错误处理（数据库写入失败不阻塞请求）

### 3.3 Web Dashboard
- [x] 实现 Dashboard API
- [x] 实现实时状态展示
- [x] 实现用量统计查询
- [x] 实现成本分析

### 3.4 告警系统
- [x] 实现 macOS 通知集成
- [x] 实现告警规则配置
- [x] 实现告警触发逻辑

### 3.5 可选：PostgreSQL 支持
- [x] 实现 PostgreSQL 适配器
- [x] 实现数据库切换逻辑
- [ ] 实现数据迁移工具

## Phase 4：生产化（1-2 天）

**目标：稳定部署**

### 4.1 部署配置
- [x] 创建 Docker Compose 配置（开发环境）
- [x] 创建 launchd 配置（生产环境）
- [x] 创建环境变量模板

### 4.2 运维脚本
- [x] 创建启动脚本
- [x] 创建停止脚本
- [x] 创建健康检查脚本
- [x] 创建日志轮转脚本

### 4.3 文档
- [x] 完善部署文档
- [x] 完善配置文档
- [x] 完善运维文档

## Phase 5：测试和优化（可选）

- [x] 单元测试
- [x] 集成测试
- [x] 故障转移测试
- [x] 性能优化

---

**当前进度：** Phase 1-5 主体实现完成，Phase 3.5 的“跨数据库数据迁移工具”仍待补齐。

**下一步：** 在用户终端环境执行 `scripts/acceptance-codex.sh` 做最终 Codex CLI 端到端复核，并视需要补充 PostgreSQL 数据迁移工具。
