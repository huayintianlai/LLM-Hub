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
