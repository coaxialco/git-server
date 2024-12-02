// src/gitserver.ts

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { join, normalize } from 'path';
import { parse } from 'url';
import { Service } from './service.js';
import { noCache, basicAuth, packSideband } from './util.js';

interface GitServerOptions {
  autoCreate?: boolean;
  authenticate?: (
    type: 'push' | 'fetch',
    repo: string,
    username?: string,
    password?: string,
  ) => Promise<void>;
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

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    console.log(`[GitServer] Received ${req.method} request: ${req.url}`);
    console.log(`[GitServer] Request headers:`, req.headers);

    const { pathname } = parse(req.url || '', true);
    if (!pathname) {
      console.log(`[GitServer] Invalid request - no pathname`);
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const match = pathname.match(
      /^\/(.+?)\/(info\/refs|git-(upload-pack|receive-pack))$/,
    );
    if (!match) {
      console.log(
        `[GitServer] Invalid request - path does not match git operation pattern: ${pathname}`,
      );
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const [, repoName, action] = match;
    const repoPath = normalize(join(this.repoDir, repoName));
    console.log(
      `[GitServer] Processing request for repo: ${repoName}, action: ${action}`,
    );
    console.log(`[GitServer] Normalized repo path: ${repoPath}`);

    if (action === 'info/refs') {
      await this.handleInfoRefs(req, res, repoName, repoPath);
    } else if (action.startsWith('git-')) {
      await this.handleService(req, res, repoName, repoPath, action);
    } else {
      console.log(`[GitServer] Invalid action: ${action}`);
      res.statusCode = 404;
      res.end('Not Found');
    }
  }

  private async handleInfoRefs(
    req: IncomingMessage,
    res: ServerResponse,
    repoName: string,
    repoPath: string,
  ): Promise<void> {
    console.log(`[GitServer] Handling info/refs for repo: ${repoName}`);

    const { query } = parse(req.url || '', true);
    const service = query['service'];
    if (!service) {
      console.log(`[GitServer] Missing service parameter in info/refs request`);
      res.statusCode = 400;
      res.end('service parameter required');
      return;
    }
    const serviceName = service.toString().replace(/^git-/, '');
    console.log(`[GitServer] Requested service: ${serviceName}`);

    if (serviceName !== 'upload-pack' && serviceName !== 'receive-pack') {
      console.log(`[GitServer] Invalid service requested: ${serviceName}`);
      res.statusCode = 400;
      res.end('Invalid service');
      return;
    }

    // Authenticate if needed
    const type = serviceName === 'receive-pack' ? 'push' : 'fetch';
    try {
      console.log(
        `[GitServer] Attempting authentication for ${type} operation`,
      );
      await this.authenticate(req, res, type, repoName);
      console.log(`[GitServer] Authentication successful`);
    } catch (error) {
      console.error(`[GitServer] Authentication failed:`, error);
      res.statusCode = 401;
      res.end('Authentication failed');
      return;
    }

    // Check if repo exists
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

    // Send response
    console.log(
      `[GitServer] Sending info/refs response for service: ${serviceName}`,
    );
    res.statusCode = 200;
    res.setHeader(
      'Content-Type',
      `application/x-git-${serviceName}-advertisement`,
    );
    noCache(res);

    const packet = `# service=git-${serviceName}\n`;
    res.write(packSideband(packet));
    res.write('0000');

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
    });

    gitProcess.on('close', (code) => {
      console.log(`[GitServer] Git refs process completed with code: ${code}`);
      res.end();
    });
  }

  private async handleService(
    req: IncomingMessage,
    res: ServerResponse,
    repoName: string,
    repoPath: string,
    action: string,
  ): Promise<void> {
    console.log(
      `[GitServer] Handling service: ${action} for repo: ${repoName}`,
    );
    const serviceName = action.replace('git-', '');

    const type = serviceName === 'receive-pack' ? 'push' : 'fetch';
    try {
      console.log(`[GitServer] Authenticating ${type} operation`);
      await this.authenticate(req, res, type, repoName);
      console.log(`[GitServer] Authentication successful`);
    } catch (error) {
      console.error(`[GitServer] Authentication failed:`, error);
      res.statusCode = 401;
      res.end('Authentication failed');
      return;
    }

    // Check if repo exists
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

    console.log(`[GitServer] Creating service instance for ${serviceName}`);
    res.statusCode = 200;
    res.setHeader('Content-Type', `application/x-git-${serviceName}-result`);
    noCache(res);

    const service = new Service(
      req,
      res,
      repoName,
      repoPath,
      serviceName,
      this,
    );

    await service.execute();
    console.log(`[GitServer] Service execution completed for ${action}`);
  }

  private async authenticate(
    req: IncomingMessage,
    res: ServerResponse,
    type: 'push' | 'fetch',
    repoName: string,
  ): Promise<void> {
    if (!this.options.authenticate) {
      console.log(
        `[GitServer] No authentication configured, allowing ${type} operation`,
      );
      return;
    }

    let authResult: { username?: string; password?: string };
    try {
      console.log(`[GitServer] Attempting to parse basic auth credentials`);
      authResult = await basicAuth(req);
      console.log(`[GitServer] Credentials parsed successfully`);
    } catch (error) {
      console.error(
        `[GitServer] Failed to parse basic auth credentials:`,
        error,
      );
      // Invalid Authorization header
      res.setHeader('WWW-Authenticate', 'Basic realm="Git Server"');
      throw error;
    }

    try {
      console.log(
        `[GitServer] Validating credentials for ${type} operation on ${repoName}`,
      );
      await this.options.authenticate(
        type,
        repoName,
        authResult.username,
        authResult.password,
      );
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
}
