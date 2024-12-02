import { IncomingMessage, ServerResponse } from 'http'

/**
 * Sets cache control headers to prevent caching
 */
export function noCache(res: ServerResponse): void {
  res.setHeader('Expires', 'Fri, 01 Jan 1980 00:00:00 GMT')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate')
}

/**
 * Formats a message for git side-band protocol
 */
export function packSideband(s: string): string {
  const length = s.length + 4
  const n = length.toString(16)
  const padded = '0'.repeat(4 - n.length) + n
  return padded + s
}

/**
 * Extracts basic auth credentials from request
 */
export async function basicAuth(
  req: IncomingMessage
): Promise<{ username?: string; password?: string }> {
  const auth = req.headers['authorization']
  if (!auth) {
    return { username: undefined, password: undefined }
  }

  const parts = auth.split(' ')
  if (parts[0] !== 'Basic' || !parts[1]) {
    return Promise.reject(new Error('Invalid authorization header'))
  }

  const decoded = Buffer.from(parts[1], 'base64').toString()
  const [username, password] = decoded.split(':')

  return { username, password }
}
