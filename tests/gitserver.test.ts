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
});
