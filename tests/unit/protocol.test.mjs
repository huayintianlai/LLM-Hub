import test from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import {
  detectProtocol,
  convertResponsesInputToMessages,
  convertResponsesToolsToChatTools,
  supportsPassthrough,
  upstreamSupportsRequestedModel,
  mapModel,
  ensureChatStreamIncludesUsage,
  transformResponsesRequestToChat,
} from '../../lib/protocol.mjs';
import { createSseParser, writeSseEvent } from '../../lib/sse.mjs';
import { ChatToResponsesStreamBridge, collectChatCompletionFromSse } from '../../lib/chat-to-responses.mjs';

test('detectProtocol distinguishes responses vs chat', () => {
  assert.strictEqual(detectProtocol('/responses'), 'responses');
  assert.strictEqual(detectProtocol('/responses/foo'), 'responses');
  assert.strictEqual(detectProtocol('/v1/chat/completions'), 'chat_completions');
  assert.strictEqual(detectProtocol('/v1/models'), 'models');
  assert.strictEqual(detectProtocol('/unknown'), 'unknown');
});

test('convertResponsesInputToMessages preserves instructions and nested input items', () => {
  const { messages, warnings } = convertResponsesInputToMessages({
    instructions: 'system note',
    input: [
      { role: 'user', content: 'hello' },
      { type: 'reasoning', content: 'ignored' },
      { role: 'assistant', content: [{ type: 'text', text: 'nested' }] },
    ],
  });
  assert.strictEqual(messages[0].role, 'system');
  assert.strictEqual(messages[0].content, 'system note');
  assert.strictEqual(messages[1].role, 'user');
  assert.strictEqual(messages[1].content, 'hello');
  assert.strictEqual(messages[2].role, 'assistant');
  assert.strictEqual(messages[2].content, 'nested');
  assert.ok(warnings.some((line) => line.includes('reasoning')));
});

test('convertResponsesToolsToChatTools merges function definitions', () => {
  const { tools, warnings } = convertResponsesToolsToChatTools([
    {
      type: 'function',
      function: {
        name: 'my_tool',
        description: 'tool test',
        parameters: { type: 'object', properties: { foo: { type: 'string' } } },
      },
    },
  ]);
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].function.name, 'my_tool');
  assert.strictEqual(tools[0].function.parameters.type, 'object');
  assert.strictEqual(warnings.length, 0);
});

test('supportsPassthrough honors streaming requirements', () => {
  const upstream = {
    capabilities: {
      supports_responses: true,
      responses_requires_stream: true,
      responses_always_streams: false,
    },
  };
  assert.ok(supportsPassthrough('responses', { stream: true }, upstream));
  assert.ok(!supportsPassthrough('responses', { stream: false }, upstream));
});

test('upstreamSupportsRequestedModel matches aliases and concrete upstream models', () => {
  const gptUpstream = {
    model_map: {
      'gpt-5.4': 'gpt-5.4',
      Openclaw: 'gpt-5.4',
    },
  };
  const claudeUpstream = {
    model_map: {
      'claude-opus-4-6': 'claude-opus-4-6',
      老金: 'claude-opus-4-6',
    },
  };

  assert.strictEqual(upstreamSupportsRequestedModel('Openclaw', gptUpstream), true);
  assert.strictEqual(upstreamSupportsRequestedModel('gpt-5.4', gptUpstream), true);
  assert.strictEqual(upstreamSupportsRequestedModel('老金', gptUpstream), false);
  assert.strictEqual(upstreamSupportsRequestedModel('claude-opus-4-6', claudeUpstream), true);
  assert.strictEqual(upstreamSupportsRequestedModel('老金', claudeUpstream), true);
});

test('upstreamSupportsRequestedModel works with new supported_models format', () => {
  const newFormatUpstream = {
    supported_models: ['gpt-5.4', 'gpt-5.3-codex'],
    model_aliases: {
      codex: 'gpt-5.3-codex',
      gpt: 'gpt-5.4',
      Openclaw: 'gpt-5.4',
    },
  };

  // 实际模型名应该被支持
  assert.strictEqual(upstreamSupportsRequestedModel('gpt-5.4', newFormatUpstream), true);
  assert.strictEqual(upstreamSupportsRequestedModel('gpt-5.3-codex', newFormatUpstream), true);

  // 别名应该被支持
  assert.strictEqual(upstreamSupportsRequestedModel('codex', newFormatUpstream), true);
  assert.strictEqual(upstreamSupportsRequestedModel('gpt', newFormatUpstream), true);
  assert.strictEqual(upstreamSupportsRequestedModel('Openclaw', newFormatUpstream), true);

  // 不支持的模型应该返回 false
  assert.strictEqual(upstreamSupportsRequestedModel('gpt-4o', newFormatUpstream), false);
  assert.strictEqual(upstreamSupportsRequestedModel('claude-opus-4-6', newFormatUpstream), false);
});

test('mapModel works with new model_aliases format', () => {
  const newFormatUpstream = {
    supported_models: ['gpt-5.4', 'gpt-5.3-codex'],
    model_aliases: {
      codex: 'gpt-5.3-codex',
      gpt: 'gpt-5.4',
    },
  };

  // 别名应该被映射到实际模型
  assert.strictEqual(mapModel('codex', newFormatUpstream), 'gpt-5.3-codex');
  assert.strictEqual(mapModel('gpt', newFormatUpstream), 'gpt-5.4');

  // 实际模型名应该保持不变
  assert.strictEqual(mapModel('gpt-5.4', newFormatUpstream), 'gpt-5.4');
  assert.strictEqual(mapModel('gpt-5.3-codex', newFormatUpstream), 'gpt-5.3-codex');
});


test('ensureChatStreamIncludesUsage only injects for streaming chat requests', () => {
  const nonStreaming = ensureChatStreamIncludesUsage({ model: 'gpt-5.4', stream: false });
  assert.strictEqual(nonStreaming.injected, false);

  const streaming = ensureChatStreamIncludesUsage({
    model: 'gpt-5.4',
    stream: true,
    stream_options: { chunk_size: 1 },
  });
  assert.strictEqual(streaming.injected, true);
  assert.strictEqual(streaming.requestBody.stream_options.include_usage, true);
  assert.strictEqual(streaming.requestBody.stream_options.chunk_size, 1);
});

test('transformResponsesRequestToChat injects include_usage when upstream chat stream is required', () => {
  const upstream = {
    capabilities: {
      supports_chat_completions: true,
      chat_always_streams: true,
    },
    model_map: {},
  };
  const { chatRequest } = transformResponsesRequestToChat(
    {
      model: 'gpt-5.4',
      input: 'hello',
      stream: false,
    },
    upstream
  );
  assert.strictEqual(chatRequest.stream, true);
  assert.strictEqual(chatRequest.stream_options.include_usage, true);
});

test('sse parser splits blocks and emits trimmed data', () => {
  const events = [];
  const parser = createSseParser((event) => {
    events.push(event);
  });
  parser.feed('event: foo\n');
  parser.feed('data: {"value":1}\n\n');
  parser.feed('data: {"value":2}\n\n');
  parser.end();
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].event, 'foo');
  assert.strictEqual(events[0].data, '{"value":1}');
  assert.strictEqual(events[1].data, '{"value":2}');
});

test('ChatToResponsesStreamBridge.buildJsonResponse includes content', () => {
  const bridge = new ChatToResponsesStreamBridge({
    requestBody: { instructions: 'note', store: true },
    upstreamId: 'mock',
    model: 'gpt',
  });
  const transformed = bridge.buildJsonResponse({
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  assert.strictEqual(transformed.model, 'gpt');
  assert.strictEqual(transformed.output.length, 1);
  assert.strictEqual(transformed.output[0].type, 'message');
  assert.strictEqual(transformed.usage.total_tokens, 3);
});

test('collectChatCompletionFromSse rebuilds chat completion payload from SSE chunks', async () => {
  const stream = Readable.from([
    Buffer.from('data: {"choices":[{"delta":{"content":"JSON"}}],"model":"gpt-5.4"}\n\n'),
    Buffer.from('data: {"choices":[{"delta":{"content":"_OK"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n'),
    Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
    Buffer.from('data: [DONE]\n\n'),
  ]);
  const payload = await collectChatCompletionFromSse(stream);
  assert.strictEqual(payload.model, 'gpt-5.4');
  assert.strictEqual(payload.choices[0].message.content, 'JSON_OK');
  assert.strictEqual(payload.usage.total_tokens, 5);
});
