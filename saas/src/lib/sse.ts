export function sseStart(res: Response) {
  const headers = new Headers({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Return the raw WritableStream from the response
  return headers;
}

export function sseWrite(controller: ReadableStreamDefaultController, data: Record<string, unknown>) {
  try {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
  } catch (e) {
    // Client disconnected
  }
}
