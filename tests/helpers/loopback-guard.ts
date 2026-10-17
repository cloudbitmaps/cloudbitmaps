import net from 'node:net';

/**
 * Refuse, and record, every connection to anything but the loopback address, so a test that talks to a loopback server
 * can show that its client tried nothing else. `restore` puts the socket's own `connect` back.
 *
 * `connect` is called with its arguments as given (`connect(port, host)`, `connect({ host, port })`, `connect(path)`),
 * or, from `net.connect` and so from every HTTP agent, with them already gathered into one array (`[options, cb]`).
 * Both are read. An agent's options carry `path: null`, and Node connects to the host when `path` is empty, so only a
 * `path` that is set and not empty names a pipe. A connection the guard refuses throws before anything is sent.
 */
export function guardLoopback(): { attempts: string[]; restore: () => void } {
  const attempts: string[] = [];
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guarded(this: net.Socket, ...args: unknown[]) {
    const given = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    const first = given[0] as { host?: unknown; path?: unknown } | number | string | undefined;
    const host =
      typeof first === 'object' && first !== null
        ? !first.path
          ? String(first.host ?? 'localhost')
          : 'pipe'
        : typeof first === 'string' && !/^\d+$/.test(first)
          ? 'pipe'
          : typeof given[1] === 'string'
            ? given[1]
            : 'localhost';
    if (!['127.0.0.1', 'localhost', '::1', 'pipe'].includes(host)) {
      attempts.push(host);
      throw new Error(`a test may connect only to the loopback address, not ${host}`);
    }
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;
  return {
    attempts,
    restore: () => {
      net.Socket.prototype.connect = connect;
    },
  };
}
