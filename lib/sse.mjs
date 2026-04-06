export function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function createSseParser(onEvent) {
  let buffer = '';

  function flushBlock(block) {
    const trimmed = block.replace(/\r/g, '');
    if (!trimmed.trim()) {
      return;
    }
    let event = 'message';
    const dataLines = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    onEvent({ event, data: dataLines.join('\n') });
  }

  return {
    feed(chunk) {
      buffer += chunk.toString('utf8');
      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) {
          break;
        }
        const endIndex = match.index;
        const block = buffer.slice(0, endIndex);
        buffer = buffer.slice(endIndex + match[0].length);
        flushBlock(block);
      }
    },
    end() {
      if (buffer.trim()) {
        flushBlock(buffer);
      }
    },
  };
}
