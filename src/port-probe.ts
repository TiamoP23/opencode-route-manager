import { createConnection } from 'node:net';

export function probeTcpPort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });

    let settled = false;

    function settle(result: boolean): void {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    }

    socket.on('connect', () => settle(true));
    socket.on('error', () => settle(false));
    socket.on('timeout', () => settle(false));

    socket.setTimeout(timeoutMs);
  });
}
