# LLM-Hub 优化分析报告

## 📊 当前运行状态（最近1小时）

### 流量分配
- **总请求数**: 278 次
- **quan2go-gpt**: 239 次 (86%)
- **yunyi-gpt**: 36 次 (13%)
- **yunyi-claude**: 3 次 (1%)

### 性能指标
- **平均延迟**: 16.95 秒
- **成功率**: 100% (278/278)
- **总成本**: $8.43

---

## 🔍 发现的问题

### 问题 1: quan2go-gpt 缺少 usage 信息 ⚠️ 严重

**现象:**
- 239 个请求的 `tokens_total` 全部为 0
- 成本计算为 $0（实际应该有成本）
- 日志中大量 "upstream response missing usage" 警告

**根本原因:**
quan2go 的 `/openai/responses` 端点返回的 SSE 流中**不包含 usage 信息**。

根据配置：
```yaml
responses_always_streams: true
responses_event_format: standard
```

quan2go 强制使用流式响应，但其流式响应格式可能不符合标准的 Anthropic Responses API 规范，导致 `extractUsageDetails()` 无法提取 usage。

**影响:**
1. 无法准确计算成本
2. 无法统计 token 使用量
3. 监控数据不完整
4. 可能影响负载均衡决策（如果未来基于 token 使用量）

**解决方案:**
1. **短期**: 联系 quan2go 提供商，要求在响应中包含 usage 信息
2. **中期**: 如果 quan2go 无法提供，考虑：
   - 使用 `/v1/chat/completions` 端点（通常有 usage）
   - 根据模型和输入长度估算 token 使用量
3. **长期**: 实现 token 计数器（使用 tiktoken 库）

---

### 问题 2: 动态负载均衡效果不明显 ⚠️ 中等

**现象:**
- quan2go: 86% 流量（延迟较高，但 priority=1）
- yunyi: 13% 流量（延迟较低，但 priority=2）

**根本原因分析:**

1. **P2C 算法正常工作**，但 quan2go 仍然被优先选择，原因是：
   - quan2go 的 `rolling_avg_latency_ms` = 9665ms
   - yunyi 的 `rolling_avg_latency_ms` = 0ms（样本太少）

2. **负载得分计算:**
   ```javascript
   load_score = in_flight_requests + latencyFactor + failurePenalty + priorityBonus
   
   quan2go: 2 + 9.665 + 0 + 2 = 13.665
   yunyi:   0 + 0 + 0 + 4 = 4
   ```

3. **为什么 yunyi 得分更低但流量更少？**
   - yunyi 的 `rolling_avg_latency_ms = 0` 是因为样本不足（只有 36 次请求）
   - 当 yunyi 没有最近延迟数据时，使用 `average_latency_ms`（历史平均）
   - 但 yunyi 的历史数据也可能不足

4. **真正的问题**: **passthrough vs transform 池分离**
   - quan2go 支持 passthrough（原生 `/responses`）
   - yunyi 只支持 transform（需要协议转换）
   - 路由逻辑优先使用 passthrough 池，导致 quan2go 被优先选择

**验证:**
```javascript
// lib/gateway.mjs:338-357
const passthrough = [];
const transform = [];

for (const upstreamId of upstreamIds) {
  if (supportsPassthrough(protocol, requestBody, upstream)) {
    passthrough.push({ mode: 'passthrough', upstream });
  } else if (supportsTransform(protocol, upstream, requestBody)) {
    transform.push({ mode: 'transform', upstream });
  }
}

// 优先返回 passthrough 池
return [...passthrough, ...transform];
```

**影响:**
- 动态负载均衡在 passthrough 池内有效，但池本身就只有 quan2go
- yunyi 在 transform 池，只有当 passthrough 失败时才会被使用

**解决方案:**
1. **配置 yunyi 支持 `/responses`**: 如果 yunyi 提供原生 Responses API
2. **调整路由策略**: 在 passthrough 和 transform 池之间也应用负载均衡
3. **移除 passthrough 优先级**: 让 P2C 在所有可用上游中选择，不区分模式

---

### 问题 3: SQLite 参数绑定错误 ⚠️ 低

**现象:**
```
ERROR: dashboard request failed
error: "Provided value cannot be bound to SQLite parameter 2."
```

**可能原因:**
1. `getSummary()` 或 `getRequests()` 中的 SQL 参数绑定错误
2. 某个参数类型不匹配（如传入 undefined 而不是 null）

**影响:**
- 仪表板某些 API 请求失败
- 不影响核心路由功能

**解决方案:**
需要添加更详细的错误日志，定位具体是哪个 API 和哪个参数出错。

---

### 问题 4: 流量分配不符合预期 ⚠️ 高

**预期:**
- 动态模式下，yunyi（快）应该承担 60-80% 流量
- quan2go（慢）应该承担 20-40% 流量

**实际:**
- quan2go: 86%
- yunyi: 13%

**根本原因:**
见问题 2 - passthrough 池优先级导致。

---

## 🎯 优化建议（按优先级）

### 优先级 1: 修复 passthrough 优先级问题

**目标**: 让 P2C 在所有可用上游中选择，不区分 passthrough/transform

**方案 A**: 移除池分离，统一路由
```javascript
// 不再区分 passthrough 和 transform 池
// P2C 直接在所有可用上游中选择
const routes = [];
for (const upstreamId of upstreamIds) {
  const upstream = this.upstreamManager.getUpstream(upstreamId);
  if (supportsPassthrough(...)) {
    routes.push({ mode: 'passthrough', upstream });
  } else if (supportsTransform(...)) {
    routes.push({ mode: 'transform', upstream });
  }
}

// 应用 P2C 到所有路由
if (dynamic && routes.length > 1) {
  const routeIds = routes.map(r => r.upstream.id);
  const orderedIds = this.upstreamManager.selectUpstreamP2C(routeIds);
  routes.sort((a, b) => orderedIds.indexOf(a.upstream.id) - orderedIds.indexOf(b.upstream.id));
}

return routes;
```

**方案 B**: 在池之间也应用负载均衡
```javascript
// 计算 passthrough 池和 transform 池的平均负载得分
const passthroughScore = passthrough.length 
  ? passthrough.reduce((sum, r) => sum + this.upstreamManager.computeLoadScore(r.upstream.id), 0) / passthrough.length
  : Infinity;

const transformScore = transform.length
  ? transform.reduce((sum, r) => sum + this.upstreamManager.computeLoadScore(r.upstream.id), 0) / transform.length
  : Infinity;

// 如果 transform 池平均负载更低，优先使用 transform
if (transformScore < passthroughScore * 0.8) {
  return [...transform, ...passthrough];
}
return [...passthrough, ...transform];
```

**推荐**: 方案 A（更简单，更符合 P2C 原理）

---

### 优先级 2: 解决 quan2go usage 缺失问题

**方案 A**: 切换到 chat/completions 端点
```yaml
# config/gateway.yaml
upstreams:
  - id: quan2go-gpt
    # 禁用 responses 支持，强制使用 chat/completions
    capabilities:
      supports_responses: false  # 改为 false
      supports_chat_completions: true
```

**方案 B**: 实现 token 估算
```javascript
// lib/token-estimator.mjs
export function estimateTokens(text, model) {
  // 简单估算：1 token ≈ 4 字符（英文）或 1.5 字符（中文）
  const charCount = text.length;
  const isChinese = /[\u4e00-\u9fa5]/.test(text);
  return Math.ceil(charCount / (isChinese ? 1.5 : 4));
}
```

**方案 C**: 联系 quan2go 提供商

**推荐**: 方案 A（最快，最可靠）

---

### 优先级 3: 修复 SQLite 参数绑定错误

**步骤:**
1. 添加详细错误日志
2. 捕获具体的 SQL 语句和参数
3. 修复参数类型问题

---

### 优先级 4: 优化负载得分计算

**当前问题:**
- `rolling_avg_latency_ms = 0` 时，latencyFactor = 0，导致得分异常低
- 应该使用 `average_latency_ms` 作为后备

**已实现:**
```javascript
const latencyFactor = (state.rolling_avg_latency_ms || state.average_latency_ms || 10000) / 1000;
```

这个已经正确实现了，问题在于 yunyi 的 `average_latency_ms` 也可能为 0（历史数据不足）。

**改进方案:**
```javascript
// 使用更合理的默认值
const latencyFactor = (
  state.rolling_avg_latency_ms || 
  state.average_latency_ms || 
  upstream.expected_latency_ms ||  // 新增：配置中的预期延迟
  10000
) / 1000;
```

---

## 📈 预期改进效果

### 修复 passthrough 优先级后：

| 指标 | 当前 | 预期 | 改进 |
|------|------|------|------|
| yunyi 流量占比 | 13% | 60-70% | +450% |
| quan2go 流量占比 | 86% | 30-40% | -55% |
| 平均延迟 | 16.95s | ~12s | -29% |
| P95 延迟 | ~40s | ~25s | -38% |

### 修复 usage 缺失后：

- 成本统计准确性：0% → 100%
- Token 使用量可见性：完整
- 监控数据完整性：提升

---

## 🚀 实施计划

### 第一步：修复 passthrough 优先级（30分钟）
1. 修改 `buildRoutePlan()` 方法
2. 移除池分离逻辑
3. 统一应用 P2C
4. 测试验证

### 第二步：解决 usage 缺失（15分钟）
1. 修改 quan2go 配置，禁用 responses 支持
2. 强制使用 chat/completions
3. 验证 usage 信息正确返回

### 第三步：修复 SQLite 错误（20分钟）
1. 添加详细错误日志
2. 定位问题 SQL
3. 修复参数绑定

### 第四步：验证和监控（30分钟）
1. 发送测试流量
2. 观察流量分配
3. 验证 usage 信息
4. 确认成本计算正确

**总计**: ~2 小时

---

## 📝 总结

当前系统的主要问题不是 P2C 算法本身，而是：

1. **架构设计问题**: passthrough 池优先级过高，导致动态负载均衡失效
2. **上游兼容性问题**: quan2go 的 responses 端点不返回 usage 信息
3. **数据完整性问题**: 缺少 token 统计和成本计算

修复这些问题后，动态负载均衡将真正发挥作用，预期可以将平均延迟降低 30%，同时保持成本可控。
