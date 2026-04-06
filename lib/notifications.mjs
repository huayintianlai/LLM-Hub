import os from 'node:os';
import { execFile } from 'node:child_process';

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
}

export async function sendMacNotification(title, message, logger) {
  if (os.platform() !== 'darwin') {
    return false;
  }
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  const result = await run('/usr/bin/osascript', ['-e', script]);
  if (result.error) {
    logger?.warn('mac notification failed', { error: result.error.message });
    return false;
  }
  return true;
}

function normalizeOpenClawGatewayUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

export function getOpenClawNotificationConfig(env = process.env) {
  return {
    gatewayUrl: env.OPENCLAW_GATEWAY_URL || '',
    gatewayToken: env.OPENCLAW_GATEWAY_TOKEN || '',
    agentId: env.NOTIFY_AGENT_ID || '',
    userId: env.NOTIFY_USER_ID || '',
  };
}

export async function sendOpenClawNotification(payload, options, logger) {
  const gatewayUrl = normalizeOpenClawGatewayUrl(options?.gatewayUrl);
  const gatewayToken = options?.gatewayToken;
  const agentId = options?.agentId;
  const userId = options?.userId;

  if (!gatewayUrl || !gatewayToken || !agentId || !userId) {
    logger?.warn('openclaw notification skipped due to missing config');
    return false;
  }

  const response = await fetch(`${gatewayUrl}/api/message/send`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${gatewayToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      agent_id: agentId,
      user_id: userId,
      message: payload.message,
      metadata: payload.metadata || {},
    }),
  }).catch((error) => {
    throw new Error(`OpenClaw request failed: ${error.message}`);
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenClaw returned ${response.status}: ${text.slice(0, 200)}`);
  }

  return true;
}
