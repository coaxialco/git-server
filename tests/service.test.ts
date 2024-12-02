import { EventEmitter } from 'events';
import { IncomingMessage, ServerResponse } from 'http';
import { PassThrough } from 'stream';
import { jest } from '@jest/globals';
import { GitServer } from '../src/gitserver';
import { Service } from '../src/service';

describe('Service', () => {
  let mockReq: Partial<IncomingMessage>;
  let mockRes: Partial<ServerResponse>;
  let mockGitServer: Partial<GitServer>;
  let service: Service;

  beforeEach(() => {
    mockReq = new EventEmitter() as Partial<IncomingMessage>;
    const pipeMock = jest.fn((dest: PassThrough) => dest);
    (mockReq as { pipe: typeof pipeMock }).pipe = pipeMock;

    mockRes = {
      setHeader: jest.fn().mockReturnThis(),
      statusCode: 200,
      end: jest.fn().mockReturnThis(),
    } as unknown as Partial<ServerResponse>;

    mockGitServer = new EventEmitter() as Partial<GitServer>;

    service = new Service(
      mockReq as IncomingMessage,
      mockRes as ServerResponse,
      'test-repo',
      '/path/to/repo',
      'upload-pack',
      mockGitServer as GitServer,
    );
  });

  test('should handle fetch request correctly', async () => {
    const mockStream = new PassThrough();

    setTimeout(() => {
      mockStream.write('mock git data\n');
      mockStream.end();
    }, 100);

    await service.execute();

    expect(mockRes.statusCode).toBe(200);
  });

  test('should handle push request correctly', async () => {
    service = new Service(
      mockReq as IncomingMessage,
      mockRes as ServerResponse,
      'test-repo',
      '/path/to/repo',
      'receive-pack',
      mockGitServer as GitServer,
    );

    const mockStream = new PassThrough();

    setTimeout(() => {
      mockStream.write('mock git push data\n');
      mockStream.end();
    }, 100);

    await service.execute();

    expect(mockRes.statusCode).toBe(200);
  });

  test('should handle rejection', async () => {
    const executePromise = service.execute();

    // We need to wait for the next tick to ensure the execute promise is running
    await new Promise((resolve) => setTimeout(resolve, 0));

    service.emit('rejected', 'Access denied');
    await executePromise;

    expect(mockRes.statusCode).toBe(500);
    expect(mockRes.end).toHaveBeenCalledWith('Access denied');
  });
});
