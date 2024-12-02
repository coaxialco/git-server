import { IncomingMessage, ServerResponse } from 'http';

export function noCache(res: ServerResponse) {
  res.setHeader('Expires', 'Fri, 01 Jan 1980 00:00:00 GMT');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
}

export function packSideband(s: string): string {
  const n = (4 + s.length).toString(16);
  const padded = '0'.repeat(4 - n.length) + n;
  return padded + s;
}

export async function basicAuth(
  req: IncomingMessage,
): Promise<{ username?: string; password?: string }> {
  const auth = req.headers['authorization'];
  if (!auth) {
    // Return undefined credentials instead of throwing an error
    return { username: undefined, password: undefined };
  }

  const parts = auth.split(' ');
  if (parts[0] !== 'Basic' || !parts[1]) {
    return Promise.reject(new Error('Invalid authorization header'));
  }

  const decoded = Buffer.from(parts[1], 'base64').toString();
  const [username, password] = decoded.split(':');

  return { username, password };
}
