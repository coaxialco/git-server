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
  }

  public listen(port: number): void {
    this.server = createServer(this.handleRequest.bind(this));
    this.server.listen(port);
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const { pathname } = parse(req.url || '', true);
    if (!pathname) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const match = pathname.match(
      /^\/(.+?)\/(info\/refs|git-(upload-pack|receive-pack))$/,
    );
    if (!match) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const [, repoName, action] = match;
    const repoPath = normalize(join(this.repoDir, repoName));

    if (action === 'info/refs') {
      await this.handleInfoRefs(req, res, repoName, repoPath);
    } else if (action.startsWith('git-')) {
      await this.handleService(req, res, repoName, repoPath, action);
    } else {
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
    const { query } = parse(req.url || '', true);
    const service = query['service'];
    if (!service) {
      res.statusCode = 400;
      res.end('service parameter required');
      return;
    }
    const serviceName = service.toString().replace(/^git-/, '');

    if (serviceName !== 'upload-pack' && serviceName !== 'receive-pack') {
      res.statusCode = 400;
      res.end('Invalid service');
      return;
    }

    // Authenticate if needed
    const type = serviceName === 'receive-pack' ? 'push' : 'fetch';
    try {
      await this.authenticate(req, res, type, repoName);
    } catch (error) {
      console.error('Authentication error:', error);
      res.statusCode = 401;
      res.end('Authentication failed');
      return;
    }

    // Check if repo exists
    try {
      await fs.access(repoPath);
    } catch (error) {
      if (this.options.autoCreate) {
        await this.createRepo(repoPath);
      } else {
        console.error('Repository not found:', error);
        res.statusCode = 404;
        res.end('Repository not found');
        return;
      }
    }

    // Send response
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

    gitProcess.stdout.pipe(res);

    gitProcess.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
    });

    gitProcess.on('error', (error) => {
      console.error('Git process error occurred:', error);
    });

    gitProcess.on('close', () => {
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
    const serviceName = action.replace('git-', '');

    const type = serviceName === 'receive-pack' ? 'push' : 'fetch';
    try {
      await this.authenticate(req, res, type, repoName);
    } catch (error) {
      console.error('Authentication error:', error);
      res.statusCode = 401;
      res.end('Authentication failed');
      return;
    }

    // Check if repo exists
    try {
      await fs.access(repoPath);
    } catch (error) {
      console.error('Repository access error:', error);
      res.statusCode = 404;
      res.end('Repository not found');
      return;
    }

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
  }

  private async authenticate(
    req: IncomingMessage,
    res: ServerResponse,
    type: 'push' | 'fetch',
    repoName: string,
  ): Promise<void> {
    if (!this.options.authenticate) {
      return;
    }

    try {
      const { username, password } = await basicAuth(req);
      await this.options.authenticate(type, repoName, username, password);
    } catch (error) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Git Server"');
      throw error;
    }
  }

  private async createRepo(repoPath: string): Promise<void> {
    await fs.mkdir(repoPath, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const gitProcess = spawn('git', ['init', '--bare', repoPath]);

      gitProcess.on('error', (error) => {
        reject(error);
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`git init exited with code ${code}`));
        }
      });
    });
  }
}
