import net from "node:net";

/**
 * Does something answer on this endpoint? Only a refused connection proves nobody does: a daemon
 * too busy to accept in time still owns its endpoint, so a timeout counts as alive.
 */
export function endpointAlive(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise<boolean>((done) => {
    const sock = net.connect({ path });
    const timer = setTimeout(() => {
      sock.destroy();
      done(true);
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      done(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}
