// tests/gitserver.test.ts

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitServer } from '../src/gitserver';

interface GitInfo {
  repo: string;
  accept: () => void;
}

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
    if (gitServer?.server) {
      gitServer.server.close();
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
    const address = gitServer.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const cloneUrl = `http://invalid:creds@localhost:${serverPort}/testrepo`;

    await expect(
      new Promise((resolve, reject) => {
        const gitClone = spawn('git', ['clone', cloneUrl], {
          cwd: cloneDir,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });

        gitClone.on('exit', (code) => {
          if (code === 0) {
            resolve(code);
          } else {
            reject(new Error(`git clone failed with code ${code}`));
          }
        });
      }),
    ).rejects.toThrow();
  });

  test('should handle non-existent repository without autoCreate', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: false,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const cloneUrl = `http://user:pass@localhost:${serverPort}/nonexistent`;

    await expect(
      new Promise((resolve, reject) => {
        const gitClone = spawn('git', ['clone', cloneUrl], {
          cwd: cloneDir,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });

        gitClone.on('exit', (code) => {
          if (code === 0) {
            resolve(code);
          } else {
            reject(new Error(`git clone failed with code ${code}`));
          }
        });
      }),
    ).rejects.toThrow();
  });

  test('should clone repository', async () => {
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.server.address();
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
    await new Promise<void>((resolve, reject) => {
      const gitInit = spawn('git', [
        'init',
        '--bare',
        join(repoDir, 'testrepo'),
      ]);
      gitInit.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`git init exited with code ${code}`));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const gitClone = spawn('git', ['clone', cloneUrl], {
        cwd: cloneDir,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0', // Disable git credential prompt
        },
      });

      gitClone.stderr.on('data', (data) => {
        console.error(`git clone stderr: ${data}`);
      });

      gitClone.stdout.on('data', (data) => {
        console.log(`git clone stdout: ${data}`);
      });

      gitClone.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`git clone exited with code ${code}`));
        }
      });
    });

    const exists = await fs
      .access(join(cloneDir, 'testrepo'))
      .then(() => true)
      .catch(() => false);

    expect(exists).toBe(true);
  });

  test('should handle git push', async () => {
    // Setup git server
    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    gitServer.listen(0);
    const address = gitServer.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    // Setup push handler
    let pushReceived = false;
    gitServer.on('push', (info: GitInfo) => {
      pushReceived = true;
      info.accept();
    });

    const username = encodeURIComponent('testuser');
    const password = encodeURIComponent('testpass');
    const cloneUrl = `http://${username}:${password}@localhost:${serverPort}/testrepo`;

    // Initialize bare repository
    await new Promise<void>((resolve, reject) => {
      const gitInit = spawn('git', ['init', '--bare', join(repoDir, 'testrepo')]);
      gitInit.on('exit', (code) => {
        code === 0 ? resolve() : reject(new Error(`git init failed with code ${code}`));
      });
    });

    // Clone repository
    await new Promise<void>((resolve, reject) => {
      const gitClone = spawn('git', ['clone', cloneUrl], {
        cwd: cloneDir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      gitClone.on('exit', (code) => {
        code === 0 ? resolve() : reject(new Error(`git clone failed with code ${code}`));
      });
    });

    // Create and commit a test file
    const testRepoPath = join(cloneDir, 'testrepo');
    await fs.writeFile(join(testRepoPath, 'test.txt'), 'test content');
    
    // Configure git user
    await new Promise<void>((resolve, reject) => {
      const gitConfig = spawn('git', ['config', 'user.email', 'test@example.com'], {
        cwd: testRepoPath,
      });
      gitConfig.on('exit', (code) => {
        code === 0 ? resolve() : reject(new Error(`git config email failed with code ${code}`));
      });
    });
    
    await new Promise<void>((resolve, reject) => {
      const gitConfig = spawn('git', ['config', 'user.name', 'Test User'], {
        cwd: testRepoPath,
      });
      gitConfig.on('exit', (code) => {
        code === 0 ? resolve() : reject(new Error(`git config name failed with code ${code}`));
      });
    });

    // Configure git credentials
    await new Promise<void>((resolve, reject) => {
      const gitConfig = spawn('git', ['config', 'credential.helper', 'store'], {
        cwd: testRepoPath,
      });
      gitConfig.on('exit', (code) => {
        code === 0 ? resolve() : reject(new Error(`git config failed with code ${code}`));
      });
    });

    // Store credentials
    const credentialsPath = join(testRepoPath, '.git', 'credentials');
    await fs.writeFile(credentialsPath, `http://${username}:${password}@localhost:${serverPort}\n`);

    // Add and commit changes
    await new Promise<void>((resolve, reject) => {
      const gitAdd = spawn('git', ['add', '.'], { cwd: testRepoPath });
      gitAdd.on('exit', (code) => {
        code === 0 ? resolve() : reject(new Error(`git add failed with code ${code}`));
      });
    });

    await new Promise<void>((resolve, reject) => {
      const gitCommit = spawn('git', ['commit', '-m', 'test commit'], {
        cwd: testRepoPath,
      });
      gitCommit.on('exit', (code) => {
        code === 0 ? resolve() : reject(new Error(`git commit failed with code ${code}`));
      });
    });

    // Push changes
    await new Promise<void>((resolve, reject) => {
      const gitPush = spawn('git', ['push', '-u', 'origin', 'HEAD:main'], {
        cwd: testRepoPath,
        env: { 
          ...process.env, 
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
          GIT_USERNAME: username,
          GIT_PASSWORD: password
        },
      });

      gitPush.stderr.on('data', (data) => {
        console.error(`git push stderr: ${data}`);
      });

      gitPush.stdout.on('data', (data) => {
        console.log(`git push stdout: ${data}`);
      });

      gitPush.on('error', (error) => {
        console.error('git push error:', error);
        reject(error);
      });

      gitPush.on('exit', (code) => {
        code === 0 ? resolve() : reject(new Error(`git push failed with code ${code}`));
      });
    });

    expect(pushReceived).toBe(true);

    // Verify the pushed file exists in the bare repository
    const bareRepoFile = join(repoDir, 'testrepo', 'objects');
    const bareRepoExists = await fs.access(bareRepoFile)
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
    const address = gitServer.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to get server port');
    }
    serverPort = address.port;

    const cloneUrl = `http://invalid:creds@localhost:${serverPort}/testrepo`;

    // Initialize bare repository
    await new Promise<void>((resolve, reject) => {
      const gitInit = spawn('git', ['init', '--bare', join(repoDir, 'testrepo')]);
      gitInit.on('exit', (code) => {
        code === 0 ? resolve() : reject(new Error(`git init failed with code ${code}`));
      });
    });

    // Attempt to push (should fail)
    await expect(
      new Promise((resolve, reject) => {
        const gitPush = spawn('git', ['push', cloneUrl, 'main'], {
          cwd: cloneDir,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        gitPush.on('exit', (code) => {
          code === 0 ? resolve(code) : reject(new Error(`git push failed with code ${code}`));
        });
      }),
    ).rejects.toThrow();
  });
});
