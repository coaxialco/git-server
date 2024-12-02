// src/gitserver.ts

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { PassThrough } from 'stream';
import { join, normalize } from 'path';
import { parse } from 'url';

interface GitServerOptions {
  autoCreate?: boolean;
  authenticate?: (
    type: 'push' | 'fetch',
    repo: string,
    username?: string,
    password?: string,
  ) => Promise<void>;
}

/**
 * Sets cache control headers to prevent caching
 */
function noCache(res: ServerResponse): void {
  res.setHeader('Expires', 'Fri, 01 Jan 1980 00:00:00 GMT');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
}

export class GitServer extends EventEmitter {
  private repoDir: string;
  private options: GitServerOptions;
  public server!: Server;

  constructor(repoDir: string, options: GitServerOptions = {}) {
    super();
    this.repoDir = repoDir;
    this.options = options;
    console.log(`[GitServer] Initialized with repo directory: ${repoDir}`);
    console.log(`[GitServer] Options:`, {
      autoCreate: options.autoCreate,
      hasAuthenticator: !!options.authenticate,
    });
  }

  public listen(port: number): void {
    console.log(`[GitServer] Starting server on port ${port}`);
    this.server = createServer(this.handleRequest.bind(this));
    this.server.listen(port);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    console.log(`[GitServer] Received ${req.method} request: ${req.url}`);
    console.log(`[GitServer] Request headers:`, req.headers);

    const path = parse(req.url || '').pathname || '';
    const [, repoName, action] = path.match(/^\/(.+?)\/(info\/refs|git-(?:upload|receive)-pack)$/) || [];
    
    if (!repoName || !action) {
      console.log(`[GitServer] Invalid request path: ${path}`);
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const repoPath = normalize(join(this.repoDir, repoName));
    console.log(`[GitServer] Processing request for repo: ${repoName}, action: ${action}`);
    console.log(`[GitServer] Normalized repo path: ${repoPath}`);

    action === 'info/refs' 
      ? await this.handleInfoRefs(req, res, repoName, repoPath)
      : await this.handleService(req, res, repoName, repoPath, action);
  }

  private async handleInfoRefs(
    req: IncomingMessage,
    res: ServerResponse,
    repoName: string,
    repoPath: string,
  ): Promise<void> {
    console.log(`[GitServer] Handling info/refs for repo: ${repoName}`);

    const service = parse(req.url || '', true).query['service']?.toString();
    if (!service) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain');
      res.end('service parameter required');
      return;
    }

    const serviceName = service.replace(/^git-/, '');
    const validServices = ['upload-pack', 'receive-pack'];
    if (!validServices.includes(serviceName)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Invalid service');
      return;
    }

    const type = this.getOperationType(serviceName);

    try {
      console.log(`[GitServer] Attempting authentication for ${type} operation`);
      await this.authenticate(req, res, type, repoName);
      console.log(`[GitServer] Authentication successful`);
    } catch (error) {
      console.error(`[GitServer] Authentication failed:`, error);
      res.statusCode = 401;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Authentication failed');
      return;
    }

    try {
      console.log(`[GitServer] Checking repository existence: ${repoPath}`);
      await fs.access(repoPath);
      console.log(`[GitServer] Repository exists`);
    } catch (error) {
      if (this.options.autoCreate) {
        console.log(
          `[GitServer] Repository does not exist, auto-creating: ${repoPath}`,
        );
        await this.createRepo(repoPath);
      } else {
        console.error(
          `[GitServer] Repository not found and auto-create disabled:`,
          error,
        );
        res.statusCode = 404;
        res.end('Repository not found');
        return;
      }
    }

    let accepted = false;
    let rejected = false;

    const handleAccept = () => {
      if (accepted || rejected) return;
      accepted = true;

      console.log(`[GitServer] ${type} info/refs accepted, sending advertisement`);
      res.statusCode = 200;
      res.setHeader(
        'Content-Type',
        `application/x-git-${serviceName}-advertisement`,
      );
      noCache(res);

      const packet = `# service=git-${serviceName}\n`;
      const length = (packet.length + 4).toString(16).padStart(4, '0');
      res.write(length + packet + '0000');

      const gitProcess = spawn('git', [
        serviceName,
        '--stateless-rpc',
        '--advertise-refs',
        repoPath,
      ]);

      console.log(`[GitServer] Spawned git process for refs advertisement`);

      gitProcess.stdout.pipe(res);

      gitProcess.stderr.on('data', (data) => {
        console.error(`[GitServer] Git refs process stderr: ${data}`);
      });

      gitProcess.on('error', (error) => {
        console.error(`[GitServer] Git refs process error:`, error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(`Git process error: ${error.message}`);
        }
      });

      gitProcess.on('close', (code) => {
        console.log(`[GitServer] Git refs process completed with code: ${code}`);
        if (!res.headersSent) {
          if (code === 0) {
            res.end();
          } else {
            res.statusCode = 500;
            res.end(`Git process exited with code ${code}`);
          }
        }
      });
    };

    const handleReject = (message: string) => {
      if (accepted || rejected) return;
      rejected = true;

      console.log(`[GitServer] ${type} info/refs rejected: ${message}`);
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain');
      res.end(message);
    };

    // Emit event and wait for response or timeout
    const info = {
      repo: repoName,
      accept: () => handleAccept(),
      reject: (message = 'rejected') => handleReject(message),
    };

    console.log(`[GitServer] Emitting ${type} event`);
    this.emit(type, info);

    // Wait for either accept, reject, or timeout
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!accepted && !rejected) {
          console.log(`[GitServer] Auto-accepting ${type} info/refs after timeout`);
          handleAccept();
        }
        resolve();
      }, 1000);
    });
  }

  private async handleService(
    req: IncomingMessage,
    res: ServerResponse,
    repoName: string,
    repoPath: string,
    action: string,
  ): Promise<void> {
    console.log(`[GitServer] Handling service: ${action} for repo: ${repoName}`);
    const serviceName = action.replace('git-', '');
    const type = this.getOperationType(serviceName);

    try {
      console.log(`[GitServer] Authenticating ${type} operation`);
      await this.authenticate(req, res, type, repoName);
      console.log(`[GitServer] Authentication successful`);
    } catch (error) {
      console.error(`[GitServer] Authentication failed:`, error);
      res.statusCode = 401;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Authentication failed');
      return;
    }

    try {
      console.log(`[GitServer] Checking repository existence: ${repoPath}`);
      await fs.access(repoPath);
      console.log(`[GitServer] Repository exists`);
    } catch (error) {
      console.error(`[GitServer] Repository access error:`, error);
      res.statusCode = 404;
      res.end('Repository not found');
      return;
    }

    // Create a paused buffer for request data
    const buffered = new PassThrough();
    req.pipe(buffered);
    buffered.pause();

    let accepted = false;
    let rejected = false;

    const handleAccept = () => {
      if (accepted || rejected) return;
      accepted = true;
      
      console.log(`[GitServer] ${type} operation accepted, spawning git process`);
      res.statusCode = 200;
      res.setHeader('Content-Type', `application/x-git-${serviceName}-result`);
      noCache(res);

      const args = [serviceName, '--stateless-rpc', repoPath];
      const gitProcess = spawn('git', args);

      gitProcess.stderr.on('data', (data) => {
        console.error(`[GitServer] Git process stderr: ${data}`);
      });

      gitProcess.on('error', (error) => {
        console.error(`[GitServer] Git process error:`, error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(`Git process error: ${error.message}`);
        }
      });

      gitProcess.on('close', (code) => {
        console.log(`[GitServer] Git process closed with code ${code}`);
        if (!res.headersSent) {
          if (code === 0) {
            res.end();
          } else {
            res.statusCode = 500;
            res.end(`Git process exited with code ${code}`);
          }
        }
      });

      // Setup the stream pipeline
      gitProcess.stdout.pipe(res);
      buffered.pipe(gitProcess.stdin);
      buffered.resume();
    };

    const handleReject = (message: string) => {
      if (accepted || rejected) return;
      rejected = true;
      
      console.log(`[GitServer] ${type} operation rejected: ${message}`);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain');
      res.end(message);
    };

    // Emit event and wait for response or timeout
    const info = {
      repo: repoName,
      accept: () => handleAccept(),
      reject: (message = 'rejected') => handleReject(message),
    };

    console.log(`[GitServer] Emitting ${type} event`);
    this.emit(type, info);

    // Wait for either accept, reject, or timeout
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!accepted && !rejected) {
          console.log(`[GitServer] Auto-accepting ${type} operation after timeout`);
          handleAccept();
        }
        resolve();
      }, 1000);
    });
  }

  private async authenticate(
    req: IncomingMessage,
    res: ServerResponse,
    type: 'push' | 'fetch',
    repoName: string,
  ): Promise<void> {
    if (!this.options.authenticate) {
      console.log(`[GitServer] No authentication configured, allowing ${type} operation`);
      return;
    }

    const auth = req.headers.authorization;
    const [username, password] = auth
      ? Buffer.from(auth.split(' ')[1] || '', 'base64')
          .toString()
          .split(':')
      : [];

    try {
      console.log(`[GitServer] Validating credentials for ${type} operation on ${repoName}`);
      await this.options.authenticate(type, repoName, username, password);
      console.log(`[GitServer] Credentials validated successfully`);
    } catch (error) {
      console.error(`[GitServer] Credential validation failed:`, error);
      res.setHeader('WWW-Authenticate', 'Basic realm="Git Server"');
      throw error;
    }
  }

  private async createRepo(repoPath: string): Promise<void> {
    console.log(`[GitServer] Creating new bare repository at: ${repoPath}`);
    await fs.mkdir(repoPath, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      console.log(`[GitServer] Initializing bare git repository`);
      const gitProcess = spawn('git', ['init', '--bare', repoPath]);

      gitProcess.stderr.on('data', (data) => {
        console.log(`[GitServer] Git init process stderr: ${data}`);
      });

      gitProcess.on('error', (error) => {
        console.error(`[GitServer] Git init process error:`, error);
        reject(error);
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          console.log(`[GitServer] Repository created successfully`);
          resolve();
        } else {
          console.error(
            `[GitServer] Repository creation failed with code: ${code}`,
          );
          reject(new Error(`Failed to create repository: exit code ${code}`));
        }
      });
    });
  }

  private getOperationType(serviceName: string): 'push' | 'fetch' {
    return serviceName === 'receive-pack' ? 'push' : 'fetch';
  }
}
