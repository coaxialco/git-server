import { promises as fs } from 'fs';
import { mkdtemp } from 'fs/promises';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { execa } from 'execa';
import { GitServer, GitInfo, TagInfo } from '../src/index.js';

describe('GitServer', () => {
  let gitServer: GitServer;
  let repoDir: string;
  let serverPort: number;
  let cloneDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'git-server-test-'));
    cloneDir = await mkdtemp(join(tmpdir(), 'git-clone-test-'));
  });

  afterEach(async () => {
    if (gitServer) {
      gitServer.close();
    }
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(cloneDir, { recursive: true, force: true });
  });

  test('should handle authentication failure', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => {
        throw new Error('Auth failed');
      },
    });

    gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const cloneUrl = `http://invalid:creds@localhost:${serverPort}/testrepo`;

    await expect(
      execa('git', ['clone', cloneUrl], {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }),
    ).rejects.toThrow();
  });

  test('should handle non-existent repository without autoCreate', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: false,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const cloneUrl = `http://user:pass@localhost:${serverPort}/nonexistent`;

    await expect(
      execa('git', ['clone', cloneUrl], {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }),
    ).rejects.toThrow();
  });

  test('should clone repository', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    gitServer.on('push', (info: GitInfo) => {
      info.accept();
    });

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const cloneUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize the test repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    await execa('git', ['clone', cloneUrl], {
      cwd: cloneDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    const exists = await fs
      .access(join(cloneDir, 'testrepo'))
      .then(() => true)
      .catch(() => false);

    expect(exists).toBe(true);
  });

  test('should handle git push', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    let pushReceived = false;
    gitServer.on('push', (info: GitInfo) => {
      pushReceived = true;
      info.accept();
    });

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const cloneUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize bare repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    // Clone repository
    await execa('git', ['clone', cloneUrl], {
      cwd: cloneDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    const testRepoPath = join(cloneDir, 'testrepo');
    await fs.writeFile(join(testRepoPath, 'test.txt'), 'test content');

    // Configure git
    await execa('git', ['config', 'user.email', 'test@example.com'], {
      cwd: testRepoPath,
    });
    await execa('git', ['config', 'user.name', 'Test User'], {
      cwd: testRepoPath,
    });
    await execa('git', ['config', 'credential.helper', 'store'], {
      cwd: testRepoPath,
    });

    // Store credentials
    const credentialsPath = join(testRepoPath, '.git', 'credentials');
    await fs.writeFile(
      credentialsPath,
      `http://${username}:${password}@localhost:${serverPort}\n`,
    );

    // Add and commit changes
    await execa('git', ['add', '.'], { cwd: testRepoPath });
    await execa('git', ['commit', '-m', 'test commit'], { cwd: testRepoPath });

    // Push changes
    await execa('git', ['push', '-u', 'origin', 'HEAD:main'], {
      cwd: testRepoPath,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GIT_USERNAME: username,
        GIT_PASSWORD: password,
      },
    });

    expect(pushReceived).toBe(true);

    const bareRepoFile = join(repoDir, 'testrepo', 'objects');
    const bareRepoExists = await fs
      .access(bareRepoFile)
      .then(() => true)
      .catch(() => false);

    expect(bareRepoExists).toBe(true);
  }, 10000);

  test('should reject unauthorized push', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => {
        throw new Error('Unauthorized push');
      },
    });

    gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const cloneUrl = `http://invalid:creds@localhost:${serverPort}/testrepo`;

    // Initialize bare repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    // Attempt to push (should fail)
    await expect(
      execa('git', ['push', cloneUrl, 'main'], {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }),
    ).rejects.toThrow();
  });

  test('should auto-accept after timeout if no explicit accept/reject', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const cloneUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    let eventReceived = false;
    gitServer.once('fetch', () => {
      eventReceived = true;
    });

    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    await execa('git', ['clone', cloneUrl], {
      cwd: cloneDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    expect(eventReceived).toBe(true);
  });

  test('should handle explicit rejection', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const cloneUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize bare repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    // Add event listener that explicitly rejects
    gitServer.once('fetch', (info: GitInfo) => {
      info.reject('Operation rejected by test');
    });

    // Attempt to clone (should fail)
    await expect(
      execa('git', ['clone', cloneUrl], {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }),
    ).rejects.toThrow();
  });

  test('should ignore multiple accept/reject calls', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const cloneUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize bare repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    let acceptCallCount = 0;
    let rejectCallCount = 0;

    // Add event listener that tries multiple accepts and rejects
    gitServer.once('fetch', (info: GitInfo) => {
      // Try to accept multiple times
      info.accept();
      info.accept();
      acceptCallCount += 2;

      // Try to reject after accept
      info.reject('Should be ignored');
      rejectCallCount += 1;
    });

    // Clone repository
    await execa('git', ['clone', cloneUrl], {
      cwd: cloneDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    expect(acceptCallCount).toBe(2);
    expect(rejectCallCount).toBe(1);

    const exists = await fs
      .access(join(cloneDir, 'testrepo'))
      .then(() => true)
      .catch(() => false);

    expect(exists).toBe(true);
  });

  test('should handle head event', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    // Setup head handler
    let headReceived = false;
    gitServer.on('head', (info: GitInfo) => {
      headReceived = true;
      info.accept();
    });

    // Initialize bare repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    // Make a HEAD request
    await new Promise<void>((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: serverPort,
        path: '/testrepo/HEAD',
        method: 'GET',
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(
              new Error(`HEAD request failed with status ${res.statusCode}`),
            );
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.end();
    });

    // Verify head event was received
    expect(headReceived).toBe(true);
  });

  test('should emit info event for repository operations', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    // Setup info handler
    let infoReceived = false;
    let receivedRepo: string | undefined;
    gitServer.on('info', (info: GitInfo) => {
      infoReceived = true;
      receivedRepo = info.repo;
      info.accept();
    });

    // Initialize bare repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    // Make an info/refs request
    await new Promise<void>((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: serverPort,
        path: '/testrepo/info/refs?service=git-upload-pack',
        method: 'GET',
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(
              new Error(
                `info/refs request failed with status ${res.statusCode}`,
              ),
            );
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.end();
    });

    // Verify info event was received with correct repository
    expect(infoReceived).toBe(true);
    expect(receivedRepo).toBe('testrepo');
  });

  test('should handle tag event', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    let tagReceived = false;
    let receivedTagInfo: TagInfo | undefined;
    gitServer.on('tag', (info: TagInfo) => {
      tagReceived = true;
      receivedTagInfo = info;
      info.accept();
    });

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const cloneUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize and setup repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);
    await execa('git', ['clone', cloneUrl], {
      cwd: cloneDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    const testRepoPath = join(cloneDir, 'testrepo');

    // Configure git
    await execa('git', ['config', 'user.email', 'test@example.com'], {
      cwd: testRepoPath,
    });
    await execa('git', ['config', 'user.name', 'Test User'], {
      cwd: testRepoPath,
    });

    // Create and commit test file
    await fs.writeFile(join(testRepoPath, 'test.txt'), 'test content');
    await execa('git', ['add', '.'], { cwd: testRepoPath });
    await execa('git', ['commit', '-m', 'test commit'], { cwd: testRepoPath });

    // Create and push tag
    await execa('git', ['tag', '-a', 'v1.0.0', '-m', 'First release'], {
      cwd: testRepoPath,
    });

    await execa('git', ['push', 'origin', 'v1.0.0'], {
      cwd: testRepoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    expect(tagReceived).toBe(true);
    expect(receivedTagInfo).toBeDefined();
    if (receivedTagInfo) {
      expect(receivedTagInfo.repo).toBe('testrepo');
      expect(receivedTagInfo.version).toEqual('v1.0.0');
    }
  });
});
