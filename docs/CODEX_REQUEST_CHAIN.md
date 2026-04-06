# Codex 请求链路、关键字段与当前 Yunyi 可用参数

## 1. 文档目的

这份文档只做三件事：

1. 说明当前 `Codex` 请求链路是怎么走的。
2. 说明每一层所说的“请求形状”到底指什么。
3. 记录当前已经跑通的 `yunyi` 链路参数。

这里的“形状”不是抽象概念，指的是下面这些东西的组合：

- 请求 URL 路径
- 认证头
- JSON body 的字段名和嵌套结构
- 流式响应的事件名与事件顺序

只要上面任一项不符合接收方预期，就可能出现“同一个模型、同一个 key，但换一层代理后不能用”的情况。

## 2. 当前存在的两条链路

### 2.1 直连 quan2go 的链路

当前 `~/.codex/config.toml` 中，默认 provider 现在是：

```toml
model_provider = "crs"

[model_providers.crs]
name = "crs"
base_url = "https://capi.quan2go.com/openai"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "<your_quan2go_token>"
```

这条链路是：

```text
Codex CLI -> https://capi.quan2go.com/openai -> quan2go 上游
```

这条链路下，真实 `codex exec` 已验证可用。

### 2.2 当前 Yunyi + LiteLLM 的可用链路

这条链路是：

```text
Codex CLI -> http://127.0.0.1:4105 -> 本地 codex_proxy.mjs -> http://127.0.0.1:4000 -> LiteLLM -> https://yunyi.cfd/codex/v1
```

这条链路也已真实验证可用。

## 3. 各环节请求形状

## 3.1 Codex CLI 发出的原始请求形状

当 `wire_api = "responses"` 时，Codex CLI 发给 provider 的入口是 `responses` 语义。

典型特征：

- URL 路径：`/responses`
- 认证头：`Authorization: Bearer <token>`
- 常见 JSON 字段：
  - `model`
  - `instructions`
  - `input`
  - `tools`
  - `tool_choice`
  - `parallel_tool_calls`
  - `reasoning`
  - `stream`
  - `include`
  - `text`

代理日志里已经看到过一类真实请求键集合：

```json
[
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "prompt_cache_key",
  "text"
]
```

其中 `input` 并不一定是简单字符串，也可能是 `message` 数组；`tools` 也不是普通字符串，而是工具定义对象列表。

## 3.2 本地兼容代理期待和输出的形状

本地代理文件：`codex_proxy.mjs`

### 3.2.1 路径改写

代理把来自 Codex 的：

```text
/responses
```

改写成发给 LiteLLM 的：

```text
/v1/chat/completions
```

对应代码：

```js
if (pathname === '/responses' || pathname.startsWith('/responses/')) {
  return `/v1/chat/completions${normalizedSearch}`;
}
```

### 3.2.2 body 改写

代理会把 Codex 的 `responses` 风格 body 转成 `chat/completions` 风格 body。

主要改写规则：

- `instructions` -> 第一条 `system` message
- `input` / `messages` -> 标准 `messages[]`
- `tools` -> 标准 `function` tool 结构
- `model` -> 映射到 LiteLLM 中的模型组名

当前代码中的核心目标结构是：

```json
{
  "model": "codex",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "stream": true,
  "tools": []
}
```

### 3.2.3 响应流改写

LiteLLM 在这条可用链路下返回的是 `chat.completion.chunk` 风格的 SSE。

Codex 期待的是 `responses` 风格 SSE。代理把它补成下面这组事件顺序：

```text
response.created
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

这一步也是“形状”的一部分。

因为对 Codex 来说，流不是只要有文本就行；事件名、事件顺序、`item_id`、`content_index`、`output_index` 都要对。

## 3.3 LiteLLM 接收到的请求形状

LiteLLM 在当前可用链路里接收到的不是原始 Codex `responses` 请求，而是代理改写后的 `chat/completions` 请求。

也就是说它看到的是：

- URL：`/v1/chat/completions`
- body：
  - `model: codex`
  - `messages: [...]`
  - `stream: true`
  - 可选 `tools`

而不是原始的：

- URL：`/responses`
- body：
  - `instructions`
  - `input`
  - `include`
  - `text`
  - 等 Codex 原生字段

## 3.4 Yunyi 上游接收到的形状

在当前已跑通方案里，Yunyi 实际上是通过 LiteLLM 的 `codex` 模型组被调用。

最终重要的是：

- LiteLLM 路由到 `model_name: codex`
- 对应上游参数：
  - `model: openai/gpt-5.3-codex`
  - `api_base: https://yunyi.cfd/codex/v1`
  - `api_key: os.environ/GPT_KEY_A`

## 4. 为什么“形状”会影响能不能用

“形状”具体包括下面 4 个层面：

### 4.1 路径层

示例：

- `https://.../responses`
- `https://.../chat/completions`
- `https://.../openai`
- `https://.../v1`

很多渠道不是单纯看 host，还会根据路径决定进入哪种处理逻辑。

### 4.2 body 字段层

同样是“发一个问题”，不同系统期待的字段可能完全不同：

- 一种期待：

```json
{
  "instructions": "...",
  "input": [...],
  "stream": true
}
```

- 另一种期待：

```json
{
  "messages": [...],
  "stream": true
}
```

### 4.3 认证层

链路上的认证也不是同一个 token 从头用到尾：

- Codex -> provider：客户端 token
- Proxy -> LiteLLM：`LITELLM_MASTER_KEY`
- LiteLLM -> 上游：`GPT_KEY_A` / `GPT_KEY_B`

### 4.4 响应流层

就算请求成功，如果返回流的事件不符合 Codex 预期，Codex 也会报错。

例如之前真实出现过的错误：

```text
OutputTextDelta without active item
```

这就是因为只有 `delta`，但没有先发 `output_item.added`。

## 5. 当前 Yunyi 可用链路参数

## 5.1 Codex CLI 本地 provider 参数

当前仓库里可用的 LiteLLM 本地 provider 是 `codex`：

```toml
[model_providers.codex]
name = "codex"
base_url = "http://127.0.0.1:4105"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "<local_token>"
```

说明：

- `base_url` 指向本地兼容代理
- `wire_api = "responses"` 表示 Codex CLI 继续说 `responses` 协议
- 本地 token 只写字段，不在文档里写明文

## 5.2 本地代理参数

当前本地代理监听：

```text
http://127.0.0.1:4105
```

目标 LiteLLM：

```text
http://127.0.0.1:4000
```

代理核心行为：

- `POST /responses` -> `POST /v1/chat/completions`
- `gpt-5.4` -> `codex`
- `instructions` / `input` -> `messages`
- `chat.completion.chunk` -> Codex `responses` SSE

## 5.3 LiteLLM 当前 codex 模型组参数

当前 `config.yaml` 中已写的参数：

```yaml
- model_name: codex
  litellm_params:
    model: openai/gpt-5.3-codex
    api_base: https://yunyi.cfd/codex/v1
    api_key: os.environ/GPT_KEY_A
    timeout: 60
    max_retries: 0
    stream: true
  model_info:
    id: codex-node-a
```

当前文件里 `codex-node-b` 仍然写着：

```yaml
- model_name: codex
  litellm_params:
    model: openai/gpt-5.3-codex
    api_base: https://yunyi.cfd/codex/v1
    api_key: os.environ/GPT_KEY_B
    timeout: 60
    max_retries: 0
    stream: true
  model_info:
    id: codex-node-b
```

注意：

- 这是当前文件里的真实状态
- 它表示当前 `codex` 组实际仍然是走 `yunyi.cfd/codex/v1`
- 不是 `yunyi -> quan2go` 双渠道容灾

## 5.4 LiteLLM 路由设置

当前 `config.yaml` 中的路由设置：

```yaml
router_settings:
  routing_strategy: "simple-shuffle"
  num_retries: 2
  timeout: 60
  allowed_fails: 3
  cooldown_time: 60
  fallbacks:
    - gpt: ["gpt"]
    - codex: ["codex"]
    - claude: ["claude"]
```

## 6. 当前已确认的事实

### 6.1 已确认可用

- `Codex -> 本地代理 -> LiteLLM -> yunyi.cfd/codex/v1`
- `Codex -> quan2go /openai` 直连 provider（当前 `crs`）

### 6.2 尚未确认可作为生产容灾

- `quan2go` 作为 LiteLLM `codex` 模型组的稳定替换渠道

## 7. 最后一句总结

当前已稳定跑通的本地 LiteLLM 方案，本质是：

```text
Codex 说 responses
-> 本地代理改成 chat/completions
-> LiteLLM 路由到 codex 模型组
-> Yunyi 上游完成推理
-> 本地代理再补回 Codex 需要的 responses SSE
```

这里说的“形状”，就是上面每一层的：

- 路径
- 鉴权头
- JSON 字段结构
- SSE 事件顺序

这些组合在一起的协议形状。
