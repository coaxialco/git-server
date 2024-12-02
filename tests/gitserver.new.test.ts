import { jest } from '@jest/globals';
import { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';
import { join } from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { GitServer } from '../src/gitserver';
import { Service } from '../src/service';

jest.mock('../src/service');

describe('GitServer', () => {
  let gitServer: GitServer;
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await fs.mkdtemp('/tmp/git-server-test-');
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  describe('Server Initialization', () => {
    test('should create server with default options', () => {
      gitServer = new GitServer(repoDir);
      expect(gitServer).toBeInstanceOf(GitServer);
    });

    test('should start listening on specified port', () => {
      gitServer = new GitServer(repoDir);
      const listen = jest.spyOn(gitServer['server'], 'listen');
      gitServer.listen(8000);
      expect(listen).toHaveBeenCalledWith(8000);
    });
  });

  describe('Authentication', () => {
    test('should allow requests when no authentication is configured', async () => {
      gitServer = new GitServer(repoDir);
      const mockReq = {
        url: '/test-repo/info/refs?service=git-upload-pack',
        headers: {},
      } as IncomingMessage;
      const mockRes = {
        setHeader: jest.fn(),
        end: jest.fn(),
        statusCode: 200,
      } as unknown as ServerResponse;

      await gitServer['handleRequest'](mockReq, mockRes);
      expect(mockRes.statusCode).toBe(200);
    });

    test('should reject requests with invalid credentials', async () => {
      gitServer = new GitServer(repoDir, {
        authenticate: () => {
          throw new Error('Invalid credentials');
        },
      });

      const mockReq = {
        url: '/test-repo/info/refs?service=git-upload-pack',
        headers: {},
      } as IncomingMessage;
      const mockRes = {
        setHeader: jest.fn(),
        end: jest.fn(),
        statusCode: 200,
      } as unknown as ServerResponse;

      await gitServer['handleRequest'](mockReq, mockRes);
      expect(mockRes.statusCode).toBe(401);
    });
  });

  describe('Repository Operations', () => {
    test('should create repository when autoCreate is true', async () => {
      gitServer = new GitServer(repoDir, { autoCreate: true });
      const mockReq = {
        url: '/test-repo/info/refs?service=git-upload-pack',
        headers: {},
      } as IncomingMessage;
      const mockRes = {
        setHeader: jest.fn(),
        end: jest.fn(),
        statusCode: 200,
      } as unknown as ServerResponse;

      await gitServer['handleRequest'](mockReq, mockRes);
      const repoExists = await fs.access(join(repoDir, 'test-repo'))
        .then(() => true)
        .catch(() => false);
      expect(repoExists).toBe(true);
    });

    test('should handle non-existent repository when autoCreate is false', async () => {
      gitServer = new GitServer(repoDir, { autoCreate: false });
      const mockReq = {
        url: '/non-existent-repo/info/refs?service=git-upload-pack',
        headers: {},
      } as IncomingMessage;
      const mockRes = {
        setHeader: jest.fn(),
        end: jest.fn(),
        statusCode: 200,
      } as unknown as ServerResponse;

      await gitServer['handleRequest'](mockReq, mockRes);
      expect(mockRes.statusCode).toBe(404);
    });
  });

  describe('Git Operations', () => {
    beforeEach(async () => {
      // Set up a test repository
      await fs.mkdir(join(repoDir, 'test-repo'), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const gitInit = spawn('git', ['init', '--bare'], {
          cwd: join(repoDir, 'test-repo'),
        });
        gitInit.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`git init failed with code ${code}`));
        });
      });
    });

    test('should handle git-upload-pack service', async () => {
      gitServer = new GitServer(repoDir);
      const mockReq = {
        url: '/test-repo/git-upload-pack',
        headers: {},
        pipe: jest.fn().mockReturnValue(new Readable({ read() {} })),
        on: jest.fn(),
      } as unknown as IncomingMessage;

      const mockRes = {
        setHeader: jest.fn().mockImplementation(() => mockRes),
        write: jest.fn().mockImplementation(() => true),
        end: jest.fn().mockImplementation(() => mockRes),
        statusCode: 200,
      } as unknown as ServerResponse;

      // Mock the service module
      const mockService = {
        execute: jest.fn().mockResolvedValue(void 0),
        on: jest.fn(),
        emit: jest.fn(),
        once: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        removeAllListeners: jest.fn(),
        listeners: jest.fn(),
        rawListeners: jest.fn(),
        listenerCount: jest.fn(),
        prependListener: jest.fn(),
        prependOnceListener: jest.fn(),
        eventNames: jest.fn(),
        off: jest.fn(),
        setMaxListeners: jest.fn(),
        getMaxListeners: jest.fn(),
      };

      (Service as jest.MockedClass<typeof Service>).mockImplementation(() => mockService as jest.Mocked<Service>);

      const boundHandleRequest = (req: IncomingMessage, res: ServerResponse) =>
        gitServer['handleRequest'](req, res);

      await boundHandleRequest(mockReq, mockRes);
      expect(mockRes.statusCode).toBe(200);
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/x-git-upload-pack-result',
      );
    }, 15000); // Increase timeout to 15 seconds

    test('should handle git-receive-pack service', async () => {
      gitServer = new GitServer(repoDir);
      const mockReq = {
        url: '/test-repo/git-receive-pack',
        headers: {},
        pipe: jest.fn().mockReturnValue(new Readable({ read() {} })),
        on: jest.fn(),
      } as unknown as IncomingMessage;

      const mockRes = {
        setHeader: jest.fn().mockImplementation(() => mockRes),
        write: jest.fn().mockImplementation(() => true),
        end: jest.fn().mockImplementation(() => mockRes),
        statusCode: 200,
      } as unknown as ServerResponse;

      // Mock the service module
      const mockService = {
        execute: jest.fn().mockResolvedValue(void 0),
        on: jest.fn(),
        emit: jest.fn(),
        once: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        removeAllListeners: jest.fn(),
        listeners: jest.fn(),
        rawListeners: jest.fn(),
        listenerCount: jest.fn(),
        prependListener: jest.fn(),
        prependOnceListener: jest.fn(),
        eventNames: jest.fn(),
        off: jest.fn(),
        setMaxListeners: jest.fn(),
        getMaxListeners: jest.fn(),
      };

      (Service as jest.MockedClass<typeof Service>).mockImplementation(() => mockService as jest.Mocked<Service>);

      const boundHandleRequest = (req: IncomingMessage, res: ServerResponse) =>
        gitServer['handleRequest'](req, res);

      await boundHandleRequest(mockReq, mockRes);
      expect(mockRes.statusCode).toBe(200);
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/x-git-receive-pack-result',
      );
    }, 15000); // Increase timeout to 15 seconds
  });

  describe('Error Handling', () => {
    test('should handle invalid URLs', async () => {
      gitServer = new GitServer(repoDir);
      const mockReq = {
        url: '/invalid-url',
        headers: {},
      } as IncomingMessage;
      const mockRes = {
        setHeader: jest.fn(),
        end: jest.fn(),
        statusCode: 200,
      } as unknown as ServerResponse;

      await gitServer['handleRequest'](mockReq, mockRes);
      expect(mockRes.statusCode).toBe(400);
    });

    test('should handle invalid service names', async () => {
      gitServer = new GitServer(repoDir);
      const mockReq = {
        url: '/test-repo/info/refs?service=invalid-service',
        headers: {},
      } as IncomingMessage;
      const mockRes = {
        setHeader: jest.fn(),
        end: jest.fn(),
        statusCode: 200,
      } as unknown as ServerResponse;

      await gitServer['handleRequest'](mockReq, mockRes);
      expect(mockRes.statusCode).toBe(400);
    });

    test('should handle missing service parameter', async () => {
      gitServer = new GitServer(repoDir);
      const mockReq = {
        url: '/test-repo/info/refs',
        headers: {},
      } as IncomingMessage;
      const mockRes = {
        setHeader: jest.fn(),
        end: jest.fn(),
        statusCode: 200,
      } as unknown as ServerResponse;

      await gitServer['handleRequest'](mockReq, mockRes);
      expect(mockRes.statusCode).toBe(400);
    });
  });
});
