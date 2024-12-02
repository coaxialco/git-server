import { describe, it, expect } from '@jest/globals'
import { IncomingMessage, ServerResponse } from 'http'
import { packSideband, basicAuth, noCache } from '../src/util'

describe('HTTP Utility Functions', () => {
  describe('packSideband', () => {
    it('should format message with correct length prefix', () => {
      expect(packSideband('test')).toBe('0008test')
      expect(packSideband('longer message')).toBe('0012longer message')
    })
  })

  describe('noCache', () => {
    it('should set correct cache control headers', () => {
      const headers: Record<string, string> = {}
      const res = {
        setHeader: (name: string, value: string) => {
          headers[name] = value
        }
      } as ServerResponse

      noCache(res)

      expect(headers).toEqual({
        'Expires': 'Fri, 01 Jan 1980 00:00:00 GMT',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache, max-age=0, must-revalidate'
      })
    })
  })

  describe('basicAuth', () => {
    it('should parse basic auth header correctly', async () => {
      const req = {
        headers: {
          'authorization': 'Basic ' + Buffer.from('user:pass').toString('base64')
        }
      } as IncomingMessage

      const result = await basicAuth(req)
      expect(result).toEqual({
        username: 'user',
        password: 'pass'
      })
    })

    it('should handle missing auth header', async () => {
      const req = { headers: {} } as IncomingMessage
      const result = await basicAuth(req)
      expect(result).toEqual({
        username: undefined,
        password: undefined
      })
    })

    it('should reject invalid auth header', async () => {
      const req = {
        headers: {
          'authorization': 'Invalid'
        }
      } as IncomingMessage

      await expect(basicAuth(req)).rejects.toThrow('Invalid authorization header')
    })
  })
})
