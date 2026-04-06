import { createSseParser, writeSseEvent } from './sse.mjs';
import { generateId } from './protocol.mjs';

function epochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function buildTextContent(text) {
  return [{ type: 'output_text', annotations: [], logprobs: [], text }];
}

function parseArgumentsString(value) {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function collectChatCompletionFromSse(stream) {
  const state = {
    model: null,
    usage: null,
    content: '',
    toolCalls: new Map(),
    finishReason: null,
  };

  const parser = createSseParser(({ data }) => {
    if (!data || data === '[DONE]') {
      return;
    }
    const payload = JSON.parse(data);
    if (payload.model) {
      state.model = payload.model;
    }
    if (payload.usage) {
      state.usage = payload.usage;
    }
    const choice = payload.choices?.[0];
    if (!choice) {
      return;
    }
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') {
      state.content += delta.content;
    } else if (Array.isArray(delta.content)) {
      for (const item of delta.content) {
        state.content += item?.text || item?.content || '';
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        const index = Number(toolCall.index || 0);
        const current = state.toolCalls.get(index) || {
          id: toolCall.id || generateId('call'),
          type: 'function',
          function: {
            name: toolCall.function?.name || '',
            arguments: '',
          },
        };
        if (toolCall.id) {
          current.id = toolCall.id;
        }
        if (toolCall.function?.name) {
          current.function.name = toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
          current.function.arguments += toolCall.function.arguments;
        }
        state.toolCalls.set(index, current);
      }
    }
    if (choice.finish_reason) {
      state.finishReason = choice.finish_reason;
    }
  });

  for await (const chunk of stream) {
    parser.feed(chunk);
  }
  parser.end();

  const toolCalls = [...state.toolCalls.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => value);

  const message = {
    role: 'assistant',
    content: state.content,
  };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: toolCall.type,
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    }));
  }

  return {
    id: generateId('chatcmpl'),
    object: 'chat.completion',
    created: epochSeconds(),
    model: state.model || 'unknown',
    choices: [
      {
        index: 0,
        message,
        finish_reason: state.finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
      },
    ],
    usage: state.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export class ChatToResponsesStreamBridge {
  constructor({ requestBody, upstreamId, model }) {
    this.requestBody = requestBody || {};
    this.upstreamId = upstreamId;
    this.model = model || this.requestBody.model || 'unknown';
    this.responseId = generateId('resp');
    this.createdAt = epochSeconds();
    this.sequenceNumber = 0;
    this.outputItems = [];
    this.messageItem = null;
    this.messageText = '';
    this.toolCalls = new Map();
    this.completed = false;
    this.usage = null;
  }

  nextSequence() {
    const value = this.sequenceNumber;
    this.sequenceNumber += 1;
    return value;
  }

  createBaseResponse(status) {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      background: false,
      completed_at: status === 'completed' ? epochSeconds() : null,
      error: null,
      instructions: this.requestBody.instructions || null,
      max_output_tokens: this.requestBody.max_output_tokens ?? null,
      model: this.model,
      output: status === 'completed' ? this.outputItems : [],
      parallel_tool_calls: this.requestBody.parallel_tool_calls ?? true,
      previous_response_id: this.requestBody.previous_response_id || null,
      reasoning: this.requestBody.reasoning || null,
      service_tier: this.requestBody.service_tier || 'default',
      store: this.requestBody.store ?? false,
      text: this.requestBody.text || { format: { type: 'text' } },
      tool_choice: this.requestBody.tool_choice || 'auto',
      tools: this.requestBody.tools || [],
      usage: status === 'completed' ? this.usage : null,
      metadata: this.requestBody.metadata || {},
    };
  }

  writeInitialEvents(res) {
    writeSseEvent(res, 'response.created', {
      type: 'response.created',
      response: this.createBaseResponse('in_progress'),
      sequence_number: this.nextSequence(),
    });
    writeSseEvent(res, 'response.in_progress', {
      type: 'response.in_progress',
      response: this.createBaseResponse('in_progress'),
      sequence_number: this.nextSequence(),
    });
  }

  ensureMessageItem(res) {
    if (this.messageItem) {
      return;
    }
    this.messageItem = {
      id: generateId('msg'),
      type: 'message',
      status: 'in_progress',
      content: [],
      phase: 'final_answer',
      role: 'assistant',
    };
    writeSseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      item: this.messageItem,
      output_index: this.outputItems.length,
      sequence_number: this.nextSequence(),
    });
    writeSseEvent(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      content_index: 0,
      item_id: this.messageItem.id,
      output_index: this.outputItems.length,
      part: { type: 'output_text', annotations: [], logprobs: [], text: '' },
      sequence_number: this.nextSequence(),
    });
  }

  ensureToolCall(res, index, delta) {
    if (this.toolCalls.has(index)) {
      const existing = this.toolCalls.get(index);
      if (delta.function?.name) {
        existing.name = delta.function.name;
      }
      if (delta.id) {
        existing.call_id = delta.id;
      }
      return existing;
    }

    const item = {
      id: generateId('fc'),
      type: 'function_call',
      call_id: delta.id || generateId('call'),
      name: delta.function?.name || '',
      arguments: '',
      status: 'in_progress',
    };
    this.toolCalls.set(index, item);
    writeSseEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      item,
      output_index: this.outputItems.length + (this.messageItem ? 1 : 0) + index,
      sequence_number: this.nextSequence(),
    });
    return item;
  }

  appendTextDelta(res, deltaText) {
    if (!deltaText) {
      return;
    }
    this.ensureMessageItem(res);
    this.messageText += deltaText;
    writeSseEvent(res, 'response.output_text.delta', {
      type: 'response.output_text.delta',
      content_index: 0,
      delta: deltaText,
      item_id: this.messageItem.id,
      logprobs: [],
      output_index: this.outputItems.length,
      sequence_number: this.nextSequence(),
    });
  }

  appendToolCallDelta(res, deltaToolCall) {
    const index = Number(deltaToolCall.index || 0);
    const item = this.ensureToolCall(res, index, deltaToolCall);
    const argsDelta = deltaToolCall.function?.arguments || '';
    if (!argsDelta) {
      return;
    }
    item.arguments += argsDelta;
    writeSseEvent(res, 'response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: this.outputItems.length + (this.messageItem ? 1 : 0) + index,
      delta: argsDelta,
      sequence_number: this.nextSequence(),
    });
  }

  finalizeMessage(res) {
    if (!this.messageItem) {
      return;
    }
    this.messageItem.status = 'completed';
    this.messageItem.content = buildTextContent(this.messageText);

    writeSseEvent(res, 'response.output_text.done', {
      type: 'response.output_text.done',
      content_index: 0,
      item_id: this.messageItem.id,
      logprobs: [],
      output_index: this.outputItems.length,
      sequence_number: this.nextSequence(),
      text: this.messageText,
    });
    writeSseEvent(res, 'response.content_part.done', {
      type: 'response.content_part.done',
      content_index: 0,
      item_id: this.messageItem.id,
      output_index: this.outputItems.length,
      part: { type: 'output_text', annotations: [], logprobs: [], text: this.messageText },
      sequence_number: this.nextSequence(),
    });
    writeSseEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      item: this.messageItem,
      output_index: this.outputItems.length,
      sequence_number: this.nextSequence(),
    });
    this.outputItems.push(this.messageItem);
    this.messageItem = null;
  }

  finalizeToolCalls(res) {
    const ordered = [...this.toolCalls.entries()].sort((left, right) => left[0] - right[0]);
    for (const [index, item] of ordered) {
      item.status = 'completed';
      writeSseEvent(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: this.outputItems.length + index,
        arguments: item.arguments,
        sequence_number: this.nextSequence(),
      });
      writeSseEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        item,
        output_index: this.outputItems.length + index,
        sequence_number: this.nextSequence(),
      });
      this.outputItems.push(item);
    }
    this.toolCalls.clear();
  }

  complete(res, usage, actualModel) {
    if (this.completed) {
      return;
    }
    if (usage) {
      this.usage = usage;
    }
    if (actualModel) {
      this.model = actualModel;
    }
    this.finalizeMessage(res);
    this.finalizeToolCalls(res);
    this.completed = true;
    writeSseEvent(res, 'response.completed', {
      type: 'response.completed',
      response: this.createBaseResponse('completed'),
      sequence_number: this.nextSequence(),
    });
  }

  transformStreaming(upstreamRes, clientRes) {
    clientRes.writeHead(upstreamRes.statusCode || 200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    this.writeInitialEvents(clientRes);

    const parser = createSseParser(({ data }) => {
      if (!data || data === '[DONE]') {
        return;
      }
      const payload = JSON.parse(data);
      if (payload.model) {
        this.model = payload.model;
      }
      if (payload.usage) {
        this.usage = {
          input_tokens: payload.usage.prompt_tokens || 0,
          output_tokens: payload.usage.completion_tokens || 0,
          total_tokens: payload.usage.total_tokens || 0,
        };
      }
      const choice = payload.choices?.[0];
      if (!choice) {
        return;
      }
      const delta = choice.delta || {};
      if (typeof delta.content === 'string') {
        this.appendTextDelta(clientRes, delta.content);
      } else if (Array.isArray(delta.content)) {
        for (const item of delta.content) {
          const text = item?.text || item?.content || '';
          this.appendTextDelta(clientRes, text);
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) {
          this.appendToolCallDelta(clientRes, toolCall);
        }
      }
      if (choice.finish_reason) {
        this.complete(clientRes, this.usage, payload.model);
      }
    });

    return new Promise((resolve, reject) => {
      upstreamRes.on('data', (chunk) => {
        try {
          parser.feed(chunk);
        } catch (error) {
          reject(error);
        }
      });
      upstreamRes.on('end', () => {
        try {
          parser.end();
          this.complete(clientRes, this.usage, this.model);
          clientRes.end();
          resolve({
            usage: this.usage,
            model: this.model,
            output: this.outputItems,
            accumulatedText: this.messageText, // 添加累积的文本用于 token 计数
          });
        } catch (error) {
          reject(error);
        }
      });
      upstreamRes.on('error', reject);
    });
  }

  buildJsonResponse(payload) {
    const choice = payload.choices?.[0] || {};
    const message = choice.message || {};
    const output = [];

    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      for (const toolCall of message.tool_calls) {
        output.push({
          id: generateId('fc'),
          type: 'function_call',
          call_id: toolCall.id || generateId('call'),
          name: toolCall.function?.name || '',
          arguments: parseArgumentsString(toolCall.function?.arguments || ''),
          status: 'completed',
        });
      }
    }

    if (typeof message.content === 'string' && message.content.length) {
      output.push({
        id: generateId('msg'),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        phase: 'final_answer',
        content: buildTextContent(message.content),
      });
    }

    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status: 'completed',
      completed_at: epochSeconds(),
      error: null,
      model: payload.model || this.model,
      output,
      parallel_tool_calls: this.requestBody.parallel_tool_calls ?? true,
      store: this.requestBody.store ?? false,
      text: this.requestBody.text || { format: { type: 'text' } },
      tools: this.requestBody.tools || [],
      usage: {
        input_tokens: payload.usage?.prompt_tokens || 0,
        output_tokens: payload.usage?.completion_tokens || 0,
        total_tokens: payload.usage?.total_tokens || 0,
      },
      metadata: this.requestBody.metadata || {},
    };
  }
}
