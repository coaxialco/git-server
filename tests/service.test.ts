import { spawn } from 'child_process';
import { mkdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { GitServer } from '../src/gitserver';

const generateRandomString = (): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    const randomIndex = Math.floor(Math.random() * chars.length);
    result += chars.charAt(randomIndex);
  }
  return result;
};

const runGitCommand = async (
  command: string[],
  cwd: string,
): Promise<{ code: number; output: string; error: string }> => {
  return new Promise((resolve) => {
    const ps = spawn('git', command, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // Disable git credential prompt
        GIT_ASKPASS: 'echo', // Prevent GUI password prompt
      },
    });
    let output = '';
    let error = '';

    ps.stdout?.on('data', (data) => {
      output += data.toString('utf8');
    });

    ps.stderr?.on('data', (data) => {
      error += data.toString('utf8');
    });

    ps.on('exit', (code) => {
      resolve({ code: code ?? 1, output, error });
    });
  });
};

describe('Git Service', () => {
  const TEST_TIMEOUT = 30000;
  let repoDir: string;
  let srcDir: string;
  let dstDir: string;
  let gitServer: GitServer;
  let port: number;

  beforeEach(async () => {
    repoDir = path.join(os.tmpdir(), generateRandomString());
    srcDir = path.join(os.tmpdir(), generateRandomString());
    dstDir = path.join(os.tmpdir(), generateRandomString());

    await mkdir(repoDir);
    await mkdir(srcDir);
    await mkdir(dstDir);

    gitServer = new GitServer(repoDir, {
      autoCreate: true,
      authenticate: () => Promise.resolve(),
    });

    // Start server on random port
    port = Math.floor(Math.random() * ((1 << 16) - 1e4)) + 1e4;
    gitServer.listen(port);
  });

  afterEach(async () => {
    if (gitServer?.server) {
      gitServer.server.close();
    }
    await rm(repoDir, { recursive: true, force: true });
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
  });

  test(
    'should handle git push and fetch',
    async () => {
      // Initialize source repo
      await runGitCommand(['init'], srcDir);
      await runGitCommand(['config', 'user.name', 'Test User'], srcDir);
      await runGitCommand(['config', 'user.email', 'test@example.com'], srcDir);
      await runGitCommand(
        ['commit', '--allow-empty', '-m', 'Initial commit'],
        srcDir,
      );

      const username = encodeURIComponent('test');
      const password = encodeURIComponent('test');
      const remoteUrl = `http://${username}:${password}@localhost:${port}/test-repo`;

      // Add remote and push
      await runGitCommand(['remote', 'add', 'origin', remoteUrl], srcDir);

      const { code: pushCode } = await runGitCommand(
        ['push', 'origin', 'master'],
        srcDir,
      );
      expect(pushCode).toBe(0);

      // Clone to test fetch
      const { code: cloneCode } = await runGitCommand(
        ['clone', remoteUrl, 'cloned'],
        dstDir,
      );
      expect(cloneCode).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    'should handle authentication rejection',
    async () => {
      // Create server with authentication that always rejects
      const authServer = new GitServer(repoDir, {
        autoCreate: true,
        authenticate: () => Promise.reject(new Error('Access denied')),
      });

      const authPort = Math.floor(Math.random() * ((1 << 16) - 1e4)) + 1e4;
      authServer.listen(authPort);

      const username = encodeURIComponent('invalid');
      const password = encodeURIComponent('invalid');
      const remoteUrl = `http://${username}:${password}@localhost:${authPort}/test-repo`;

      // Try to clone (should fail)
      const { code: cloneCode } = await runGitCommand(
        ['clone', remoteUrl, 'cloned'],
        dstDir,
      );

      expect(cloneCode).not.toBe(0);

      authServer.server.close();
    },
    TEST_TIMEOUT,
  );
});
