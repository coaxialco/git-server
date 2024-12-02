import { ServerResponse, IncomingMessage } from 'http';
import { jest } from '@jest/globals';
import { noCache, packSideband, basicAuth } from '../src/util';

describe('Utilities', () => {
  describe('noCache', () => {
    test('should set correct cache headers', () => {
      const mockRes = {
        setHeader: jest.fn(),
      } as Partial<ServerResponse>;

      noCache(mockRes as ServerResponse);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Expires',
        'Fri, 01 Jan 1980 00:00:00 GMT',
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'no-cache, max-age=0, must-revalidate',
      );
    });
  });

  describe('packSideband', () => {
    test('should format string correctly', () => {
      const result = packSideband('test');
      expect(result).toBe('0008test');
    });

    test('should handle empty string', () => {
      const result = packSideband('');
      expect(result).toBe('0004');
    });
  });

  describe('basicAuth', () => {
    test('should parse basic auth header correctly', async () => {
      const mockReq = {
        headers: {
          authorization: 'Basic ' + Buffer.from('user:pass').toString('base64'),
        },
      } as Partial<IncomingMessage>;

      const result = await basicAuth(mockReq as IncomingMessage);
      expect(result).toEqual({ username: 'user', password: 'pass' });
    });

    test('should reject when no auth header present', async () => {
      const mockReq = { headers: {} } as Partial<IncomingMessage>;

      await expect(basicAuth(mockReq as IncomingMessage)).rejects.toThrow(
        'No authorization header',
      );
    });

    test('should reject with invalid auth header', async () => {
      const mockReq = {
        headers: {
          authorization: 'Invalid header',
        },
      } as Partial<IncomingMessage>;

      await expect(basicAuth(mockReq as IncomingMessage)).rejects.toThrow(
        'Invalid authorization header',
      );
    });
  });
});
