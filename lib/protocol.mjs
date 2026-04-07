import crypto from 'node:crypto';

function stripV1Prefix(pathname) {
  if (pathname === '/v1') {
    return '/';
  }
  if (pathname.startsWith('/v1/')) {
    return pathname.slice(3);
  }
  return pathname;
}

function isTextItem(item) {
  return item?.type === 'input_text' || item?.type === 'output_text' || item?.type === 'text';
}

function stringifyUnknown(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  return JSON.stringify(value);
}

function coerceToolOutput(output) {
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (isTextItem(item)) {
          return item.text || '';
        }
        return stringifyUnknown(item);
      })
      .join('\n');
  }
  if (output && typeof output === 'object' && typeof output.text === 'string') {
    return output.text;
  }
  return stringifyUnknown(output);
}

export function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function detectProtocol(pathname) {
  const normalized = stripV1Prefix(pathname);
  if (normalized === '/responses' || normalized.startsWith('/responses/')) {
    return 'responses';
  }
  if (normalized === '/chat/completions' || normalized.startsWith('/chat/completions/')) {
    return 'chat_completions';
  }
  if (normalized === '/models' || normalized.startsWith('/models/')) {
    return 'models';
  }
  return 'unknown';
}

export function buildGatewayPath(pathname) {
  const normalized = stripV1Prefix(pathname);
  return normalized === '/' ? pathname : normalized;
}

export function supportsPassthrough(protocol, requestBody, upstream) {
  const capabilities = upstream.capabilities || {};
  if (protocol === 'responses') {
    if (!capabilities.supports_responses) {
      return false;
    }
    const wantsStream = requestBody?.stream !== false;
    if (capabilities.responses_requires_stream && !wantsStream) {
      return false;
    }
    if (capabilities.responses_always_streams && requestBody?.stream === false) {
      return false;
    }
    return true;
  }
  if (protocol === 'chat_completions') {
    if (!capabilities.supports_chat_completions) {
      return false;
    }
    const wantsStream = requestBody?.stream === true;
    if (capabilities.chat_requires_stream && !wantsStream) {
      return false;
    }
    if (capabilities.chat_always_streams && requestBody?.stream === false) {
      return false;
    }
    return true;
  }
  return false;
}

export function supportsTransform(protocol, upstream, requestBody = null) {
  const capabilities = upstream.capabilities || {};
  if (protocol === 'responses') {
    return Boolean(capabilities.supports_chat_completions);
  }
  return false;
}

export function mapModel(model, upstream) {
  const aliases = upstream.model_aliases || upstream.model_map || {};
  return aliases[model] || model;
}

export function upstreamSupportsRequestedModel(model, upstream) {
  if (!model) {
    return true;
  }

  const supportedModels = upstream.supported_models || [];
  const aliases = upstream.model_aliases || upstream.model_map || {};

  // 检查是否是实际模型
  if (supportedModels.length > 0 && supportedModels.includes(model)) {
    return true;
  }

  // 检查是否是别名
  if (model in aliases) {
    return true;
  }

  // 向后兼容：如果没有 supported_models，检查是否在 model_map 的值中
  if (supportedModels.length === 0) {
    const modelMapValues = Object.values(aliases);
    if (modelMapValues.length === 0) {
      return true; // 无配置时支持所有模型
    }
    return modelMapValues.includes(model);
  }

  return false;
}

function contentItemsToChatContent(content, warnings) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof content.text === 'string') {
      return content.text;
    }
    return stringifyUnknown(content);
  }

  const parts = [];
  let rich = false;

  for (const item of content) {
    if (typeof item === 'string') {
      parts.push({ type: 'text', text: item });
      continue;
    }
    if (isTextItem(item)) {
      parts.push({ type: 'text', text: item.text || '' });
      continue;
    }
    if (item?.type === 'input_image' || item?.type === 'image_url') {
      const url = item.image_url?.url || item.url || item.image_url;
      if (url) {
        rich = true;
        parts.push({
          type: 'image_url',
          image_url: {
            url,
            ...(item.detail || item.image_url?.detail ? { detail: item.detail || item.image_url?.detail } : {}),
          },
        });
        continue;
      }
    }
    warnings.push(`Unsupported content item type: ${item?.type || 'unknown'}`);
  }

  if (!parts.length) {
    return '';
  }
  if (!rich && parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('');
  }
  return parts;
}

function toChatToolCall(item) {
  return {
    id: item.call_id || item.id || generateId('call'),
    type: 'function',
    function: {
      name: item.name || '',
      arguments: typeof item.arguments === 'string' ? item.arguments : stringifyUnknown(item.arguments || {}),
    },
  };
}

function normalizeInputItem(item, warnings) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  if (item.type === 'message' || item.role) {
    const role = item.role || 'user';
    const message = { role };
    if (Array.isArray(item.tool_calls)) {
      message.content = '';
      message.tool_calls = item.tool_calls.map((toolCall) => ({
        id: toolCall.id || generateId('call'),
        type: toolCall.type || 'function',
        function: {
          name: toolCall.function?.name || toolCall.name || '',
          arguments:
            toolCall.function?.arguments ||
            stringifyUnknown(toolCall.arguments || toolCall.input || {}),
        },
      }));
      return message;
    }
    message.content = contentItemsToChatContent(item.content ?? item.input ?? item.text ?? '', warnings);
    return message;
  }

  if (item.type === 'function_call') {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [toChatToolCall(item)],
    };
  }

  if (item.type === 'function_call_output') {
    return {
      role: 'tool',
      tool_call_id: item.call_id || item.tool_call_id || item.id || generateId('call'),
      content: coerceToolOutput(item.output),
    };
  }

  if (item.type === 'reasoning') {
    warnings.push('Ignored reasoning input item during chat transformation');
    return null;
  }

  if (isTextItem(item)) {
    return {
      role: 'user',
      content: item.text || '',
    };
  }

  warnings.push(`Unsupported input item type: ${item.type || 'unknown'}`);
  return {
    role: 'user',
    content: stringifyUnknown(item),
  };
}

export function convertResponsesInputToMessages(requestBody) {
  const warnings = [];
  const messages = [];

  if (requestBody.instructions) {
    messages.push({
      role: 'system',
      content: requestBody.instructions,
    });
  }

  const input = requestBody.input ?? requestBody.messages;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const normalized = normalizeInputItem(item, warnings);
      if (normalized) {
        messages.push(normalized);
      }
    }
  } else if (input && typeof input === 'object') {
    const normalized = normalizeInputItem(input, warnings);
    if (normalized) {
      messages.push(normalized);
    }
  }

  if (!messages.length) {
    messages.push({ role: 'user', content: '' });
  }

  return { messages, warnings };
}

export function convertResponsesToolsToChatTools(tools = []) {
  const warnings = [];
  const converted = [];

  for (const tool of tools) {
    if (tool?.type === 'function' || tool?.function || tool?.parameters) {
      converted.push({
        type: 'function',
        function: {
          name: tool.function?.name || tool.name || '',
          description: tool.function?.description || tool.description || '',
          parameters: tool.function?.parameters || tool.parameters || { type: 'object', properties: {} },
          ...(tool.function?.strict !== undefined || tool.strict !== undefined
            ? { strict: tool.function?.strict ?? tool.strict }
            : {}),
        },
      });
      continue;
    }

    warnings.push(`Unsupported tool type in transform mode: ${tool?.type || 'unknown'}`);
  }

  return { tools: converted, warnings };
}

export function ensureChatStreamIncludesUsage(requestBody) {
  if (!requestBody || typeof requestBody !== 'object' || requestBody.stream !== true) {
    return { requestBody, injected: false };
  }

  if (requestBody.stream_options?.include_usage === true) {
    return { requestBody, injected: false };
  }

  return {
    requestBody: {
      ...requestBody,
      stream_options: {
        ...(requestBody.stream_options || {}),
        include_usage: true,
      },
    },
    injected: true,
  };
}

export function transformResponsesRequestToChat(requestBody, upstream) {
  const { messages, warnings } = convertResponsesInputToMessages(requestBody || {});
  const mustStreamUpstream =
    upstream.capabilities?.chat_requires_stream === true ||
    upstream.capabilities?.chat_always_streams === true;
  const chatRequest = {
    model: mapModel(requestBody.model, upstream),
    messages,
    stream: requestBody.stream !== false || mustStreamUpstream,
  };

  if (requestBody.tools) {
    const converted = convertResponsesToolsToChatTools(requestBody.tools);
    if (converted.tools.length) {
      chatRequest.tools = converted.tools;
    }
    warnings.push(...converted.warnings);
  }

  const passthroughFields = [
    'tool_choice',
    'parallel_tool_calls',
    'reasoning',
    'temperature',
    'top_p',
    'presence_penalty',
    'frequency_penalty',
    'store',
    'metadata',
    'service_tier',
    'include',
    'text',
  ];

  for (const field of passthroughFields) {
    if (requestBody[field] !== undefined) {
      chatRequest[field] = requestBody[field];
    }
  }

  if (requestBody.max_output_tokens !== undefined) {
    chatRequest.max_completion_tokens = requestBody.max_output_tokens;
  }

  if (requestBody.response_format) {
    chatRequest.response_format = requestBody.response_format;
  } else if (requestBody.text?.format?.type === 'json_schema') {
    chatRequest.response_format = {
      type: 'json_schema',
      json_schema: requestBody.text.format.json_schema,
    };
  }

  const ensured = ensureChatStreamIncludesUsage(chatRequest);
  return { chatRequest: ensured.requestBody, warnings };
}

export function buildUpstreamUrl(upstream, protocol, search = '') {
  const fullPath = protocol === 'responses' ? upstream.responses_full_path : upstream.chat_full_path;
  if (!fullPath) {
    throw new Error(`Missing upstream path for ${upstream.id} and protocol ${protocol}`);
  }
  const origin = new URL(upstream.origin);
  const pathname = `${fullPath}${search || ''}`;
  return new URL(pathname, origin);
}

export function extractUsage(protocol, payload) {
  return extractUsageDetails(protocol, payload).usage;
}

export function extractUsageDetails(protocol, payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      hasUsage: false,
      usage: { prompt: 0, completion: 0, total: 0 },
    };
  }
  if (protocol === 'responses') {
    const usage = payload.response?.usage || payload.usage;
    const prompt = usage?.input_tokens || 0;
    const completion = usage?.output_tokens || 0;
    const total = usage?.total_tokens || 0;

    // 只有当 usage 存在且至少有一个非零值时，才认为有有效的 usage
    const hasValidUsage = Boolean(usage && typeof usage === 'object' && (prompt > 0 || completion > 0 || total > 0));

    return {
      hasUsage: hasValidUsage,
      usage: {
        prompt,
        completion,
        total,
      },
    };
  }
  const usage = payload.usage || {};
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  const total = usage.total_tokens || 0;

  // 只有当 usage 存在且至少有一个非零值时，才认为有有效的 usage
  const hasValidUsage = Boolean(payload.usage && typeof payload.usage === 'object' && (prompt > 0 || completion > 0 || total > 0));

  return {
    hasUsage: hasValidUsage,
    usage: {
      prompt,
      completion,
      total,
    },
  };
}
