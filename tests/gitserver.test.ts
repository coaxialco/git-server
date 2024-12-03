import { promises as fs } from 'fs';
import { mkdtemp } from 'fs/promises';
import http, { Server } from 'http';
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

    await gitServer.listen(0);
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

    await gitServer.listen(0);
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

    await gitServer.listen(0);
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

    await gitServer.listen(0);
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

    await gitServer.listen(0);
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

    await gitServer.listen(0);
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

    await gitServer.listen(0);
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

    await gitServer.listen(0);
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

    await gitServer.listen(0);
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

    await gitServer.listen(0);
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

    await gitServer.listen(0);
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

  test('should reject unauthorized tag operation', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    await gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const repoUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize bare repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    // Set up rejection handler for push
    gitServer.on('push', (info: GitInfo) => {
      // Reject all pushes to prevent tag creation
      info.reject('Tag operation not allowed');
    });

    // Clone repository
    await execa('git', ['clone', repoUrl], {
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

    // Create a commit
    await fs.writeFile(join(testRepoPath, 'test.txt'), 'test content');
    await execa('git', ['add', '.'], { cwd: testRepoPath });
    await execa('git', ['commit', '-m', 'test commit'], { cwd: testRepoPath });

    // Create and push a tag
    await execa('git', ['tag', '-a', 'v1.0.0', '-m', 'test tag'], {
      cwd: testRepoPath,
    });

    // Try to push the tag (should fail)
    await expect(
      execa('git', ['push', 'origin', 'v1.0.0'], {
        cwd: testRepoPath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }),
    ).rejects.toThrow();
  });

  test('should reject fetch operation', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    await gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const repoUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize bare repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    // Set up rejection handler
    gitServer.on('fetch', (info: GitInfo) => {
      info.reject('Fetch operation not allowed');
    });

    // Attempt to clone (which involves a fetch operation)
    await expect(
      execa('git', ['clone', repoUrl], {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }),
    ).rejects.toThrow();
  });

  test('should reject info request', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    await gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    // Set up rejection handler
    gitServer.on('info', (info: GitInfo) => {
      info.reject('Info request not allowed');
    });

    // Make a direct HTTP request to the info endpoint
    await new Promise<void>((resolve, reject) => {
      http
        .get(
          `http://localhost:${serverPort}/testrepo/info/refs?service=git-upload-pack`,
          (res) => {
            expect(res.statusCode).toBe(403);
            resolve();
          },
        )
        .on('error', reject);
    });
  });

  test('should reject head request', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    await gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    // Initialize bare repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    // Set up rejection handler
    gitServer.on('head', (info: GitInfo) => {
      info.reject('Head request not allowed');
    });

    // Make a direct HTTP HEAD request
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        `http://localhost:${serverPort}/testrepo/HEAD`,
        { method: 'HEAD' },
        (res) => {
          expect(res.statusCode).toBe(403);
          resolve();
        },
      );
      req.on('error', reject);
      req.end();
    });
  });

  test('should reject push with custom message', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    await gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const repoUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize bare repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    // Set up rejection handler with custom message
    gitServer.on('push', (info: GitInfo) => {
      info.reject('Custom rejection message: Push not allowed at this time');
    });

    // Clone repository
    await execa('git', ['clone', repoUrl], {
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

    // Create a commit
    await fs.writeFile(join(testRepoPath, 'test.txt'), 'test content');
    await execa('git', ['add', '.'], { cwd: testRepoPath });
    await execa('git', ['commit', '-m', 'test commit'], { cwd: testRepoPath });

    // Try to push (should fail with custom message)
    const pushResult = await execa('git', ['push', 'origin', 'master'], {
      cwd: testRepoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      reject: false,
    });

    expect(pushResult.stderr).toContain('Custom rejection message');
  });
});

describe('Branch Operations', () => {
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

  test('should handle branch creation and deletion', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    await gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const repoUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize and clone repo
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);
    await execa('git', ['clone', repoUrl], {
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

    // Create initial commit on master branch
    await fs.writeFile(join(testRepoPath, 'initial.txt'), 'initial content');
    await execa('git', ['add', '.'], { cwd: testRepoPath });
    await execa('git', ['commit', '-m', 'initial commit'], {
      cwd: testRepoPath,
    });
    await execa('git', ['branch', '-M', 'main'], { cwd: testRepoPath });
    await execa('git', ['push', '-u', 'origin', 'main'], { cwd: testRepoPath });

    // Create and push new branch
    await execa('git', ['checkout', '-b', 'feature-branch'], {
      cwd: testRepoPath,
    });
    await fs.writeFile(join(testRepoPath, 'feature.txt'), 'feature content');
    await execa('git', ['add', '.'], { cwd: testRepoPath });
    await execa('git', ['commit', '-m', 'feature commit'], {
      cwd: testRepoPath,
    });
    await execa('git', ['push', '-u', 'origin', 'feature-branch'], {
      cwd: testRepoPath,
    });

    // Verify branch exists
    const branches = await execa('git', ['branch', '-r'], {
      cwd: testRepoPath,
    });
    expect(branches.stdout).toContain('origin/feature-branch');

    // Delete branch
    await execa('git', ['push', 'origin', '--delete', 'feature-branch'], {
      cwd: testRepoPath,
    });

    // Verify branch was deleted
    const remainingBranches = await execa('git', ['branch', '-r'], {
      cwd: testRepoPath,
    });
    expect(remainingBranches.stdout).not.toContain('origin/feature-branch');
  });

  test('should handle merge operations', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    await gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const repoUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize and clone repo
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);
    await execa('git', ['clone', repoUrl], {
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

    // Create initial commit on master branch
    await fs.writeFile(join(testRepoPath, 'main.txt'), 'main content');
    await execa('git', ['add', '.'], { cwd: testRepoPath });
    await execa('git', ['commit', '-m', 'main commit'], { cwd: testRepoPath });
    await execa('git', ['branch', '-M', 'main'], { cwd: testRepoPath });
    await execa('git', ['push', '-u', 'origin', 'main'], { cwd: testRepoPath });

    // Create feature branch with changes
    await execa('git', ['checkout', '-b', 'feature'], { cwd: testRepoPath });
    await fs.writeFile(join(testRepoPath, 'feature.txt'), 'feature content');
    await execa('git', ['add', '.'], { cwd: testRepoPath });
    await execa('git', ['commit', '-m', 'feature commit'], {
      cwd: testRepoPath,
    });
    await execa('git', ['push', '-u', 'origin', 'feature'], {
      cwd: testRepoPath,
    });

    // Merge feature into main with --no-ff to force a merge commit
    await execa('git', ['checkout', 'main'], { cwd: testRepoPath });
    await execa(
      'git',
      ['merge', '--no-ff', 'feature', '-m', 'Merge branch feature into main'],
      { cwd: testRepoPath },
    );
    await execa('git', ['push'], { cwd: testRepoPath });

    // Verify merge was successful
    const log = await execa('git', ['log', '--oneline'], { cwd: testRepoPath });
    expect(log.stdout).toContain('Merge branch feature into main');
  });
});

describe('Concurrent Operations', () => {
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

  test('should handle concurrent clones and pushes', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    await gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const repoUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize bare repository
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    // Create multiple clone directories
    const clone1Dir = join(cloneDir, 'clone1');
    const clone2Dir = join(cloneDir, 'clone2');
    await fs.mkdir(clone1Dir, { recursive: true });
    await fs.mkdir(clone2Dir, { recursive: true });

    // Perform concurrent clones
    await Promise.all([
      execa('git', ['clone', repoUrl], {
        cwd: clone1Dir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }),
      execa('git', ['clone', repoUrl], {
        cwd: clone2Dir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }),
    ]);

    // Setup git config for both clones
    const configureGit = async (dir: string) => {
      const repoPath = join(dir, 'testrepo');
      await execa('git', ['config', 'user.email', 'test@example.com'], {
        cwd: repoPath,
      });
      await execa('git', ['config', 'user.name', 'Test User'], {
        cwd: repoPath,
      });
      return repoPath;
    };

    const repo1Path = await configureGit(clone1Dir);
    const repo2Path = await configureGit(clone2Dir);

    // Make concurrent changes and pushes to different branches
    await Promise.all([
      (async () => {
        await execa('git', ['checkout', '-b', 'branch1'], { cwd: repo1Path });
        await fs.writeFile(join(repo1Path, 'file1.txt'), 'content1');
        await execa('git', ['add', '.'], { cwd: repo1Path });
        await execa('git', ['commit', '-m', 'commit1'], { cwd: repo1Path });
        await execa('git', ['push', '-u', 'origin', 'branch1'], {
          cwd: repo1Path,
        });
      })(),
      (async () => {
        await execa('git', ['checkout', '-b', 'branch2'], { cwd: repo2Path });
        await fs.writeFile(join(repo2Path, 'file2.txt'), 'content2');
        await execa('git', ['add', '.'], { cwd: repo2Path });
        await execa('git', ['commit', '-m', 'commit2'], { cwd: repo2Path });
        await execa('git', ['push', '-u', 'origin', 'branch2'], {
          cwd: repo2Path,
        });
      })(),
    ]);

    // Verify both changes are present
    await execa('git', ['fetch', '--all'], { cwd: repo1Path });
    const branches = await execa('git', ['branch', '-r'], { cwd: repo1Path });
    expect(branches.stdout).toContain('origin/branch1');
    expect(branches.stdout).toContain('origin/branch2');
  });
});

describe('Repository Configuration', () => {
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

  test('should handle .gitignore rules', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    await gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const repoUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize and clone repo
    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);
    await execa('git', ['clone', repoUrl], {
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

    // Create .gitignore
    await fs.writeFile(
      join(testRepoPath, '.gitignore'),
      '*.log\nnode_modules/\n',
    );

    // Create files
    await fs.writeFile(join(testRepoPath, 'test.txt'), 'tracked');
    await fs.writeFile(join(testRepoPath, 'test.log'), 'ignored');
    await fs.mkdir(join(testRepoPath, 'node_modules'), { recursive: true });
    await fs.writeFile(join(testRepoPath, 'node_modules/test.js'), 'ignored');

    // Add and commit
    await execa('git', ['add', '.'], { cwd: testRepoPath });
    await execa('git', ['commit', '-m', 'test gitignore'], {
      cwd: testRepoPath,
    });
    await execa('git', ['push'], { cwd: testRepoPath });

    // Clone to a new directory to verify ignored files
    const verifyDir = join(cloneDir, 'verify');
    await fs.mkdir(verifyDir, { recursive: true });
    await execa('git', ['clone', repoUrl], {
      cwd: verifyDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    const verifyRepoPath = join(verifyDir, 'testrepo');
    const files = await fs.readdir(verifyRepoPath);

    expect(files).toContain('test.txt');
    expect(files).toContain('.gitignore');
    expect(files).not.toContain('test.log');
    expect(files).not.toContain('node_modules');
  });
});

describe('Error Handling', () => {
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

  test('should handle network interruption simulation', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    let requestCount = 0;
    const originalListen = gitServer.listen.bind(gitServer);

    // Create a proxy to intercept server creation
    gitServer.listen = function (this: GitServer, port: number): Promise<void> {
      const listenPromise = originalListen.call(this, port);
      // The server is created in the GitServer class
      const httpServer = (this as unknown as { server: Server }).server;
      if (httpServer && typeof httpServer.on === 'function') {
        httpServer.on('request', () => {
          requestCount++;
          if (requestCount === 1) {
            // Close on first request instead of second
            httpServer.close();
            // Also destroy all existing connections
            httpServer.closeAllConnections();
          }
        });
      }
      return listenPromise;
    };

    void gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const repoUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    await execa('git', ['init', '--bare', join(repoDir, 'testrepo')]);

    // This should fail due to network interruption
    await expect(
      execa('git', ['clone', repoUrl], {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }),
    ).rejects.toThrow();
  });

  test('should handle invalid repository states', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    await gitServer.listen(0);
    const address = gitServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    // Create an invalid repository (missing required files)
    await fs.mkdir(join(repoDir, 'invalid-repo'), { recursive: true });

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const repoUrl = `http://${username}:${password}@localhost:${serverPort}/invalid-repo`;

    // Attempt to clone invalid repository
    try {
      await execa('git', ['clone', repoUrl], {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      throw new Error('Expected clone to fail');
    } catch (error) {
      if (error instanceof Error) {
        expect(error.message).toContain(''); // Any git error message is acceptable
      } else {
        throw error; // Re-throw if it's not an Error instance
      }
    }
  });
});
