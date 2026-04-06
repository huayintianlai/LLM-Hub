import { encoding_for_model } from 'tiktoken';

// 缓存编码器实例
const encoderCache = new Map();

function getEncoder(model) {
  if (encoderCache.has(model)) {
    return encoderCache.get(model);
  }

  // 映射模型名称到 tiktoken 支持的模型
  const modelMap = {
    'gpt-5.4': 'gpt-4',
    'gpt-5.3-codex': 'gpt-4',
    'gpt-4': 'gpt-4',
    'gpt-3.5-turbo': 'gpt-3.5-turbo',
    'claude-opus-4-6': 'gpt-4', // Claude 使用类似的 tokenizer
  };

  const mappedModel = modelMap[model] || 'gpt-4';

  try {
    const encoder = encoding_for_model(mappedModel);
    encoderCache.set(model, encoder);
    return encoder;
  } catch (error) {
    // 如果模型不支持，使用 gpt-4 作为默认
    const encoder = encoding_for_model('gpt-4');
    encoderCache.set(model, encoder);
    return encoder;
  }
}

/**
 * 计算文本的 token 数量
 * @param {string} text - 要计算的文本
 * @param {string} model - 模型名称
 * @returns {number} token 数量
 */
export function countTokens(text, model = 'gpt-4') {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  try {
    const encoder = getEncoder(model);
    const tokens = encoder.encode(text);
    return tokens.length;
  } catch (error) {
    // 降级方案：简单估算（1 token ≈ 4 字符）
    return Math.ceil(text.length / 4);
  }
}

/**
 * 计算 Responses API 请求的 token 数量
 * @param {object} requestBody - 请求体
 * @param {string} model - 模型名称
 * @returns {object} { prompt: number, total: number }
 */
export function countResponsesRequestTokens(requestBody, model = 'gpt-4') {
  if (!requestBody) {
    return { prompt: 0, total: 0 };
  }

  let promptTokens = 0;

  // 计算 instructions
  if (requestBody.instructions) {
    promptTokens += countTokens(requestBody.instructions, model);
  }

  // 计算 input (messages)
  if (Array.isArray(requestBody.input)) {
    for (const item of requestBody.input) {
      if (item.type === 'message') {
        // 计算 role
        if (item.role) {
          promptTokens += countTokens(item.role, model);
        }

        // 计算 content
        if (Array.isArray(item.content)) {
          for (const content of item.content) {
            if (content.type === 'text' && content.text) {
              promptTokens += countTokens(content.text, model);
            } else if (content.type === 'input_text' && content.text) {
              promptTokens += countTokens(content.text, model);
            }
          }
        }
      }
    }
  }

  // 系统消息开销（约 3-5 tokens）
  const systemOverhead = 4;
  promptTokens += systemOverhead;

  return {
    prompt: promptTokens,
    total: promptTokens,
  };
}

/**
 * 计算 Responses API 响应的 token 数量
 * @param {object} responseBody - 响应体
 * @param {string} model - 模型名称
 * @returns {object} { completion: number, total: number }
 */
export function countResponsesResponseTokens(responseBody, model = 'gpt-4') {
  if (!responseBody) {
    return { completion: 0, total: 0 };
  }

  let completionTokens = 0;

  // 从 response.output 中提取文本
  if (responseBody.response?.output) {
    const output = responseBody.response.output;

    if (Array.isArray(output)) {
      for (const item of output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const content of item.content) {
            if (content.type === 'text' && content.text) {
              completionTokens += countTokens(content.text, model);
            } else if (content.type === 'output_text' && content.text) {
              completionTokens += countTokens(content.text, model);
            }
          }
        }
      }
    }
  }

  return {
    completion: completionTokens,
    total: completionTokens,
  };
}

/**
 * 从流式响应中提取文本并计算 token
 * @param {string} accumulatedText - 累积的响应文本
 * @param {string} model - 模型名称
 * @returns {object} { completion: number, total: number }
 */
export function countStreamResponseTokens(accumulatedText, model = 'gpt-4') {
  if (!accumulatedText) {
    return { completion: 0, total: 0 };
  }

  const completionTokens = countTokens(accumulatedText, model);

  return {
    completion: completionTokens,
    total: completionTokens,
  };
}

/**
 * 计算 Chat Completions 请求的 token 数量
 * @param {object} requestBody - 请求体
 * @param {string} model - 模型名称
 * @returns {object} { prompt: number, total: number }
 */
export function countChatRequestTokens(requestBody, model = 'gpt-4') {
  if (!requestBody || !Array.isArray(requestBody.messages)) {
    return { prompt: 0, total: 0 };
  }

  let promptTokens = 0;

  // 每条消息的格式开销（约 4 tokens per message）
  const messageOverhead = 4;

  for (const message of requestBody.messages) {
    promptTokens += messageOverhead;

    if (message.role) {
      promptTokens += countTokens(message.role, model);
    }

    if (message.content) {
      if (typeof message.content === 'string') {
        promptTokens += countTokens(message.content, model);
      } else if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item.type === 'text' && item.text) {
            promptTokens += countTokens(item.text, model);
          }
        }
      }
    }
  }

  // 系统消息开销
  promptTokens += 3;

  return {
    prompt: promptTokens,
    total: promptTokens,
  };
}

/**
 * 释放编码器缓存
 */
export function clearEncoderCache() {
  for (const encoder of encoderCache.values()) {
    encoder.free();
  }
  encoderCache.clear();
}
