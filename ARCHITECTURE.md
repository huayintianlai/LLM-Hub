# LLM-Hub 架构设计

> 基于 quan2go 兼容性调研的最终架构
>
> 更新日期：2026-04-06

## 一、核心问题

**原问题：** quan2go → LiteLLM → Codex CLI 不兼容

**根本原因：**
- quan2go **原生支持** `/responses` API（返回标准 Responses API 格式）
- LiteLLM 强制将 `/responses` 转换为 `/chat/completions` 再转换回来
- 转换后的格式与 quan2go 原生格式不一致，导致 Codex CLI 报错

**关键发现：**
```
✅ quan2go 支持 /v1/chat/completions（流式和非流式）
✅ quan2go 支持 /openai/responses（仅流式，原生 Responses API）
```

**最佳方案：直通，而不是转换！**

## 二、新架构设计

### 核心理念：智能协议路由

根据上游能力选择最优路径：
- **直通模式（Passthrough）**：上游原生支持请求协议 → 直接转发
- **转换模式（Transform）**：上游不支持 → 协议转换

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     应用层                                    │
│  Codex CLI │ KekeBaby │ Claude Code │ 其他应用               │
└──────┬──────────┬─────────────┬──────────────┬──────────────┘
       │          │             │              │
       │ :4105    │ :4106       │ :4107        │ :4000
       │          │             │              │
┌──────▼──────────▼─────────────▼──────────────▼──────────────┐
│              统一网关（Unified Gateway）                      │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │         请求接收层（多端口监听）                     │    │
│  │  - 4105 → app_name: codex-cli                      │    │
│  │  - 4106 → app_name: kekebaby                       │    │
│  │  - 4107 → app_name: claude-code                    │    │
│  │  - 4000 → app_name: default                        │    │
│  └────────────────┬───────────────────────────────────┘    │
│                   │                                         │
│  ┌────────────────▼───────────────────────────────────┐    │
│  │         协议检测与路由决策                           │    │
│  │  - 检测请求协议（/responses 或 /chat/completions）   │    │
│  │  - 检测上游能力（原生支持 or 需要转换）              │    │
│  │  - 智能选择路由策略                                  │    │
│  └────────────────┬───────────────────────────────────┘    │
│                   │                                         │
│         ┌─────────┴─────────┐                              │
│         │                   │                              │
│    ┌────▼────┐         ┌────▼────┐                        │
│    │直通模式  │         │转换模式  │                        │
│    │         │         │(内置)    │                        │
│    └────┬────┘         └────┬────┘                        │
│         │                   │                              │
│  ┌──────▼───────────────────▼──────────────────────┐      │
│  │  请求记录器（异步写入 SQLite）                   │      │
│  │  - 记录 app_name 和 app_port                    │      │
│  │  - 向上记录上游消耗                              │      │
│  │  - 向下拆分到项目                                │      │
│  └──────────────────────────────────────────────────┘      │
└─────────┼───────────────────┼──────────────────────────────┘
          │                   │
    ┌─────▼─────┐       ┌─────▼─────┐
    │ quan2go   │       │ yunyi     │
    │ 原生支持   │       │ 需要转换   │
    │ /responses│       │ /chat/    │
    └───────────┘       └───────────┘
```

**应用识别策略：通过端口识别**
- 不同应用连接不同端口
- 网关根据监听端口自动识别应用
- 简单可靠，无需修改应用代码

### 完整配置文件

```yaml
# config/gateway.yaml

# 网关配置
gateway:
  # 多端口监听（应用识别）
  ports:
    - port: 4105
      app_name: codex-cli
      description: "Codex CLI 专用端口"

    - port: 4106
      app_name: kekebaby
      description: "KekeBaby 专用端口"

    - port: 4107
      app_name: claude-code
      description: "Claude Code 专用端口"

    - port: 4000
      app_name: default
      description: "默认端口"

# 上游配置
upstreams:
  # quan2go：原生支持 /responses
  - id: quan2go-gpt
    name: "Quan2go GPT"

    # URL 配置（明确拆分，避免歧义）
    origin: https://capi.quan2go.com
    responses_full_path: /openai/responses
    chat_full_path: /v1/chat/completions

    api_key: os.environ/GPT_KEY_B
    priority: 1

    # 能力声明（细粒度）
    capabilities:
      # 端点支持
      supports_responses: true
      supports_chat_completions: true

      # 流式行为
      responses_requires_stream: true      # /responses 必须 stream:true
      responses_always_streams: true       # stream:false 时仍返回流
      chat_requires_stream: false
      chat_always_streams: true            # stream:false 时仍返回 SSE

      # 响应格式
      responses_event_format: "standard"   # 标准 Responses API 事件
      chat_event_format: "openai"          # 标准 OpenAI 格式

    cost:
      per_1k_prompt: 0.008
      per_1k_completion: 0.024

  # yunyi：不支持 /responses，需要转换
  - id: yunyi-gpt
    name: "Yunyi GPT"

    # URL 配置
    origin: https://yunyi.cfd
    chat_full_path: /codex/v1/chat/completions

    api_key: os.environ/GPT_KEY_A
    priority: 2

    # 能力声明
    capabilities:
      supports_responses: false            # 不支持 /responses
      supports_chat_completions: true
      chat_requires_stream: false
      chat_always_streams: false
      chat_event_format: "openai"

    cost:
      per_1k_prompt: 0.01
      per_1k_completion: 0.03

# 容灾配置
failover:
  # 被动监控
  passive_monitoring: true

  # 熔断器
  circuit_breaker:
    failure_threshold: 3        # 连续失败3次触发熔断
    initial_cooldown: 60        # 首次冷却60秒
    max_cooldown: 1800          # 最大冷却30分钟
    exponential_backoff: true   # 指数退避

  # 智能路由
  routing_strategy:
    codex-cli: latency-first    # 延迟优先
    kekebaby: cost-first        # 成本优先
    default: balanced           # 平衡策略

# 数据库配置
database:
  type: sqlite
  path: ./data/llmhub.db

  # 可选：PostgreSQL
  # type: postgres
  # url: postgresql://user:pass@host:5432/llmhub

# 监控配置
monitoring:
  enabled: true
  dashboard_port: 8080

  # macOS 通知
  notifications:
    enabled: true
    critical_only: true  # 只通知严重问题
```

### 路由决策逻辑

```javascript
async route(request, context) {
  const requestProtocol = this.detectProtocol(request);
  const availableUpstreams = await this.getAvailableUpstreams(context);

  // 优先选择支持原生协议的上游（直通模式）
  const nativeUpstreams = availableUpstreams.filter(u => {
    if (requestProtocol === 'responses') {
      return u.capabilities.supports_responses === true;
    } else if (requestProtocol === 'chat_completions') {
      return u.capabilities.supports_chat_completions === true;
    }
    return false;
  });

  if (nativeUpstreams.length > 0) {
    return {
      mode: 'passthrough',
      upstream: this.selectBestUpstream(nativeUpstreams, context),
      needsTransform: false
    };
  }

  // 没有原生支持的上游，选择需要转换的上游
  const transformUpstreams = availableUpstreams.filter(u =>
    this.canTransformTo(u, requestProtocol)
  );

  if (transformUpstreams.length > 0) {
    return {
      mode: 'transform',
      upstream: this.selectBestUpstream(transformUpstreams, context),
      needsTransform: true
    };
  }

  return null; // 没有可用上游
}
```

## 三、核心组件

### 3.1 统一网关（Unified Gateway）

**职责：**
- 多端口监听（4105/4106/4107/4000）
- 应用识别（根据端口自动识别）
- 协议检测和路由决策
- 请求转发（直通或转换）
- 容灾和故障转移
- 用量监控和成本统计

**技术选型：** Node.js

### 3.2 协议转换器（Protocol Transformer）

**职责：**
- 请求转换和响应转换（分开处理）
- 仅在转换模式下使用
- 内置在网关中，不是独立服务

**设计原则：**
- 不引入"内部统一模型"（避免过度抽象）
- 针对具体上游做适配
- 请求转换和响应转换独立

**实现示例：**
```javascript
class ProtocolAdapter {
  // Codex responses request → 上游 chat/completions request
  transformRequest(codexRequest, upstream) {
    const chatRequest = {
      model: this.mapModel(codexRequest.model, upstream),
      messages: this.convertMessages(codexRequest),
      stream: codexRequest.stream || true,
    };

    // 处理特殊字段
    if (codexRequest.tools) {
      chatRequest.tools = this.convertTools(codexRequest.tools);
    }

    if (codexRequest.reasoning) {
      // 根据上游能力处理 reasoning
      chatRequest.reasoning = codexRequest.reasoning;
    }

    return chatRequest;
  }

  // 上游 chat/completions response → Codex responses SSE
  transformResponse(upstreamChunk, upstream) {
    // 生成标准的 Responses API 事件序列
    // response.created → response.output_item.added →
    // response.content_part.added → response.output_text.delta →
    // response.output_text.done → response.content_part.done →
    // response.output_item.done → response.completed
    return this.generateResponsesEvents(upstreamChunk);
  }

  convertMessages(codexRequest) {
    const messages = [];

    if (codexRequest.instructions) {
      messages.push({
        role: 'system',
        content: codexRequest.instructions
      });
    }

    if (codexRequest.input) {
      if (Array.isArray(codexRequest.input)) {
        messages.push(...codexRequest.input);
      } else {
        messages.push({
          role: 'user',
          content: codexRequest.input
        });
      }
    }

    return messages;
  }
}
```

### 3.3 上游管理器（Upstream Manager）

**职责：**
- 管理所有上游配置
- 被动监控（基于实际请求失败/超时）
- 熔断器管理（自适应冷却：1min → 30min）
- 上游状态维护

### 3.4 请求记录器（Request Logger）

**职责：**
- 记录每个请求到 SQLite（异步写入）
- 向上记录上游消耗
- 向下拆分到项目（通过端口识别）
- 不阻塞请求处理

**数据库 Schema（兼容 SQLite 和 PostgreSQL）：**

```sql
-- 请求日志表
CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  request_id TEXT NOT NULL UNIQUE,

  -- 上游信息
  upstream_id TEXT NOT NULL,
  model TEXT NOT NULL,

  -- 下游项目信息（通过端口识别）
  app_name TEXT NOT NULL,     -- codex-cli, kekebaby, etc.
  app_port INTEGER NOT NULL,  -- 4105, 4106, etc.

  -- 请求结果
  success BOOLEAN NOT NULL,
  latency_ms INTEGER,
  error_type TEXT,
  error_message TEXT,

  -- Token 消耗（向上记录，向下拆分）
  tokens_prompt INTEGER DEFAULT 0,
  tokens_completion INTEGER DEFAULT 0,
  tokens_total INTEGER DEFAULT 0,  -- 应用层计算

  -- 成本
  cost_usd REAL DEFAULT 0
);

CREATE INDEX idx_requests_timestamp ON requests(timestamp);
CREATE INDEX idx_requests_upstream ON requests(upstream_id);
CREATE INDEX idx_requests_app ON requests(app_name);
CREATE INDEX idx_requests_port ON requests(app_port);

-- 上游状态表
CREATE TABLE upstream_states (
  upstream_id TEXT PRIMARY KEY,
  circuit_state TEXT NOT NULL,     -- 'closed', 'open', 'half_open'
  consecutive_failures INTEGER DEFAULT 0,
  cooldown_until INTEGER,
  last_failure_at INTEGER,
  last_success_at INTEGER,
  updated_at INTEGER NOT NULL
);
```

## 四、容灾策略

### 被动监控 + 自适应熔断

**被动监控：**
- 基于实际请求的成功/失败进行监控
- 记录延迟、成功率、错误类型
- 超时检测

**自适应熔断：**
- 首次故障：1 分钟冷却
- 连续故障：指数退避（5min → 15min → 30min）
- 恢复后逐步增加流量（半开状态）

**智能路由（最差里面挑最好的）：**
- 延迟优先：交互式应用（codex-cli）
- 成本优先：批量任务（kekebaby）
- 平衡策略：默认

## 五、实施计划

### Phase 1：最小可用原型（1-2 天）

**目标：** 验证直通模式可行性

- [ ] 创建简单的直通代理（simple-passthrough-proxy.mjs）
  - 监听 :4105
  - 接收 /responses 请求
  - 转发到 quan2go（使用完整路径）
  - 直接返回响应（不做任何转换）
- [ ] 配置 Codex CLI 测试
- [ ] 验证事件序列正确性

**实现示例：**
```javascript
// simple-passthrough-proxy.mjs
import http from 'http';
import https from 'https';

const QUAN2GO_KEY = process.env.GPT_KEY_B;
const PORT = 4105;

// 使用完整路径，避免 URL 拼接歧义
const QUAN2GO_ORIGIN = 'capi.quan2go.com';
const RESPONSES_FULL_PATH = '/openai/responses';

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/responses')) {
    console.log(`[${new Date().toISOString()}] Passthrough: ${req.method} ${req.url}`);

    // 构建完整路径
    const queryString = req.url.substring('/responses'.length);
    const fullPath = RESPONSES_FULL_PATH + queryString;

    const options = {
      hostname: QUAN2GO_ORIGIN,
      path: fullPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: QUAN2GO_ORIGIN,
        authorization: `Bearer ${QUAN2GO_KEY}`
      }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    req.pipe(proxyReq);

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err);
      res.writeHead(502);
      res.end('Bad Gateway');
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Passthrough proxy listening on http://127.0.0.1:${PORT}`);
});
```

### Phase 2：完整网关核心（3-4 天）

**目标：** 实现智能路由和双模式支持

- [ ] 实现协议检测
- [ ] 实现路由决策逻辑
- [ ] 实现直通模式
- [ ] 实现转换模式
- [ ] 实现容灾和故障转移

### Phase 3：监控和统计（2-3 天）

**目标：** 完整的可观测性

- [ ] SQLite 数据库集成
- [ ] 请求记录（向上记录，向下拆分）
- [ ] Web Dashboard
- [ ] 告警系统（macOS 通知）
- [ ] 可选：支持迁移到 PostgreSQL

### Phase 4：生产化（1-2 天）

**目标：** 稳定部署

- [ ] 部署配置（Docker 或 launchd）
- [ ] 运维脚本
- [ ] 文档

**总计：7-11 天**

## 六、关键决策

### 为什么自研网关？

1. **quan2go 原生支持 /responses**
   - 直通模式可以完美利用这个能力
   - LiteLLM 的转换反而是负担

2. **项目需求特殊**
   - 需要向下拆分到项目的统计
   - 需要灵活的容灾策略
   - 需要完全控制

3. **技术可行性高**
   - 协议转换逻辑已在 codex_proxy 中验证
   - 直通模式更简单
   - Node.js 实现快速

4. **长期收益**
   - 完全控制，易于优化
   - 可以根据需求快速迭代
   - 不受 LiteLLM 限制

### 应用识别：通过端口

- 不同应用连接不同端口（4105/4106/4107/4000）
- 网关根据监听端口自动识别应用
- 简单可靠，无需修改应用代码

### 数据库：优先 SQLite

- Phase 1-2 使用 SQLite（零配置）
- Phase 3 可选迁移到 PostgreSQL
- Schema 兼容两者

### URL 配置：使用完整路径

- 拆分为 `origin` + `xxx_full_path`
- 避免 URL 拼接歧义
- 配置即文档，一目了然

**示例：**
```yaml
origin: https://capi.quan2go.com
responses_full_path: /openai/responses
# 最终 URL: https://capi.quan2go.com/openai/responses
```

### 能力模型：细粒度声明

不仅声明"有没有接口"，还要声明"接口行为"：

```yaml
capabilities:
  # 端点支持
  supports_responses: true
  supports_chat_completions: true

  # 流式行为（关键！）
  responses_requires_stream: true      # 必须 stream:true
  responses_always_streams: true       # stream:false 时仍返回流

  # 响应格式
  responses_event_format: "standard"   # 事件序列格式
```

**为什么重要：**
- quan2go 的坑就是 `stream:false` 仍返回流
- 细粒度能力声明可以在路由时避免这类问题

### 协议转换：分段处理，不引入中间模型

**不采用：** 通用的"内部统一模型"（过度抽象）

**采用：** 针对性适配
- 请求转换：Codex request → 上游 request
- 响应转换：上游 response → Codex response
- 两者独立，针对具体上游优化

### 错误处理策略

**所有上游不可用：**
- 返回 503 Service Unavailable
- 发送 macOS 通知
- 记录到日志

**协议转换失败：**
- 记录错误日志
- 尝试其他上游
- 如果都失败，返回 500

**数据库写入失败：**
- 不阻塞请求
- 记录到本地日志文件
- 继续处理请求

---

**下一步：立即开始 Phase 1，创建最小可用原型**
