// src/gitserver.ts

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { AddressInfo } from 'net';
import { join, normalize } from 'path';
import { PassThrough } from 'stream';
import { parse } from 'url';
import { execa } from 'execa';

interface GitServerOptions {
  autoCreate?: boolean;
  authenticate?: (
    type: 'push' | 'fetch',
    repo: string,
    username?: string,
    password?: string,
  ) => Promise<void>;
}

export type GitInfo = {
  repo: string;
  accept: () => void;
  reject: (message?: string) => void;
};

export type TagInfo = {
  repo: string;
  commit: string;
  version: string;
  accept: () => void;
  reject: (message?: string) => void;
};

export class GitServer extends EventEmitter {
  private repositoryDirectory: string;
  private options: GitServerOptions;
  private server!: Server;

  constructor(repositoryDirectory: string, options: GitServerOptions = {}) {
    super();
    this.repositoryDirectory = repositoryDirectory;
    this.options = options;
    console.log(
      `[GitServer] Initialized with repo directory: ${repositoryDirectory}`,
    );
    console.log(`[GitServer] Options:`, {
      autoCreate: options.autoCreate,
      hasAuthenticator: !!options.authenticate,
    });
  }

  public address(): string | AddressInfo | null {
    return this.server.address();
  }

  public close(): void {
    if (this.server) {
      this.server.close();
    }
  }

  public listen(port: number): void {
    console.log(`[GitServer] Starting server on port ${port}`);
    this.server = createServer(this.handleRequest.bind(this));
    this.server.listen(port);
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    console.log(
      `[GitServer] Received ${request.method} request: ${request.url}`,
    );
    console.log(`[GitServer] Request headers:`, request.headers);

    const requestPath = parse(request.url || '').pathname || '';
    const [, repositoryName, action] =
      requestPath.match(
        /^\/(.+?)\/(info\/refs|git-(?:upload|receive)-pack|HEAD)$/,
      ) || [];

    if (!repositoryName || !action) {
      console.log(`[GitServer] Invalid request path: ${requestPath}`);
      response.statusCode = 404;
      response.end('Not Found');
      return;
    }

    const repositoryPath = normalize(
      join(this.repositoryDirectory, repositoryName),
    );
    console.log(
      `[GitServer] Processing request for repo: ${repositoryName}, action: ${action}`,
    );
    console.log(`[GitServer] Normalized repo path: ${repositoryPath}`);

    if (action === 'HEAD') {
      await this.handleHead(request, response, repositoryName, repositoryPath);
    } else if (action === 'info/refs') {
      await this.handleInfoRefs(
        request,
        response,
        repositoryName,
        repositoryPath,
      );
    } else {
      await this.handleService(
        request,
        response,
        repositoryName,
        repositoryPath,
        action,
      );
    }
  }

  private async handleInfoRefs(
    request: IncomingMessage,
    response: ServerResponse,
    repositoryName: string,
    repositoryPath: string,
  ): Promise<void> {
    console.log(`[GitServer] Handling info/refs for repo: ${repositoryName}`);

    const service = parse(request.url || '', true).query['service']?.toString();
    if (!service) {
      response.statusCode = 400;
      response.setHeader('Content-Type', 'text/plain');
      response.end('service parameter required');
      return;
    }

    const gitServiceName = service.replace(/^git-/, '');
    const validServices = ['upload-pack', 'receive-pack'];
    if (!validServices.includes(gitServiceName)) {
      response.statusCode = 400;
      response.setHeader('Content-Type', 'text/plain');
      response.end('Invalid service');
      return;
    }

    const operationType = this.getOperationType(gitServiceName);

    try {
      console.log(
        `[GitServer] Attempting authentication for ${operationType} operation`,
      );
      await this.authenticate(request, response, operationType, repositoryName);
      console.log(`[GitServer] Authentication successful`);
    } catch (error) {
      console.error(`[GitServer] Authentication failed:`, error);
      response.statusCode = 401;
      response.setHeader('Content-Type', 'text/plain');
      response.end('Authentication failed');
      return;
    }

    try {
      console.log(
        `[GitServer] Checking repository existence: ${repositoryPath}`,
      );
      await fs.access(repositoryPath);
      console.log(`[GitServer] Repository exists`);
    } catch (error) {
      if (this.options.autoCreate) {
        console.log(
          `[GitServer] Repository does not exist, auto-creating: ${repositoryPath}`,
        );
        await this.createRepo(repositoryPath);
      } else {
        console.error(
          `[GitServer] Repository not found and auto-create disabled:`,
          error,
        );
        response.statusCode = 404;
        response.end('Repository not found');
        return;
      }
    }

    let accepted = false;
    let rejected = false;

    const handleAccept = async () => {
      if (accepted || rejected) return;
      accepted = true;

      console.log(
        `[GitServer] ${operationType} info/refs accepted, sending advertisement`,
      );
      response.statusCode = 200;
      response.setHeader(
        'Content-Type',
        `application/x-git-${gitServiceName}-advertisement`,
      );
      this.setNoCacheHeaders(response);

      const packet = `# service=git-${gitServiceName}\n`;
      const length = (packet.length + 4).toString(16).padStart(4, '0');
      response.write(length + packet + '0000');

      try {
        const subprocess = execa(
          'git',
          [
            gitServiceName,
            '--stateless-rpc',
            '--advertise-refs',
            repositoryPath,
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );

        console.log(`[GitServer] Spawned git process for refs advertisement`);

        if (subprocess.stderr) {
          subprocess.stderr.on('data', (data) => {
            console.error(`[GitServer] Git refs process stderr: ${data}`);
          });
        }

        if (subprocess.stdout) {
          subprocess.stdout.pipe(response);
        }

        await subprocess;

        if (!response.headersSent) {
          response.end();
        }
      } catch (error) {
        console.error(`[GitServer] Git refs process error:`, error);
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end(`Git process error: ${String(error)}`);
        }
      }
    };

    const handleReject = (message: string) => {
      if (accepted || rejected) return;
      rejected = true;

      console.log(
        `[GitServer] ${operationType} info/refs rejected: ${message}`,
      );
      response.statusCode = 403;
      response.setHeader('Content-Type', 'text/plain');
      response.end(message);
    };

    const info = {
      repo: repositoryName,
      accept: () => handleAccept(),
      reject: (message = 'rejected') => handleReject(message),
    };

    // Emit info event first
    this.emit('info', info);

    // Then emit the specific operation type event
    this.emit(operationType, info);

    // If no listeners for either event, auto-accept
    if (
      this.listenerCount('info') === 0 &&
      this.listenerCount(operationType) === 0
    ) {
      await handleAccept();
    }
  }

  private async handleService(
    request: IncomingMessage,
    response: ServerResponse,
    repositoryName: string,
    repositoryPath: string,
    action: string,
  ): Promise<void> {
    console.log(
      `[GitServer] Handling service: ${action} for repo: ${repositoryName}`,
    );
    const gitServiceName = action.replace('git-', '');
    const operationType = this.getOperationType(gitServiceName);

    try {
      console.log(`[GitServer] Authenticating ${operationType} operation`);
      await this.authenticate(request, response, operationType, repositoryName);
      console.log(`[GitServer] Authentication successful`);
    } catch (error) {
      console.error(`[GitServer] Authentication failed:`, error);
      response.statusCode = 401;
      response.setHeader('Content-Type', 'text/plain');
      response.end('Authentication failed');
      return;
    }

    try {
      console.log(
        `[GitServer] Checking repository existence: ${repositoryPath}`,
      );
      await fs.access(repositoryPath);
      console.log(`[GitServer] Repository exists`);
    } catch (error) {
      console.error(`[GitServer] Repository access error:`, error);
      response.statusCode = 404;
      response.end('Repository not found');
      return;
    }

    // Create a paused buffer for request data
    const bufferedStream = new PassThrough();
    request.pipe(bufferedStream);
    bufferedStream.pause();

    let accepted = false;
    let rejected = false;

    const handleAccept = () => {
      if (accepted || rejected) return;
      accepted = true;

      console.log(
        `[GitServer] ${operationType} operation accepted, spawning git process`,
      );
      response.statusCode = 200;
      response.setHeader(
        'Content-Type',
        `application/x-git-${gitServiceName}-result`,
      );
      this.setNoCacheHeaders(response);

      const args = [gitServiceName, '--stateless-rpc', repositoryPath];
      const gitProcess = spawn('git', args);

      // Parse git protocol data for tag detection
      if (operationType === 'push') {
        let data = '';
        request.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          const matches = data.match(
            /([0-9a-fA-F]+) ([0-9a-fA-F]+) refs\/tags\/(.*?)(?:[ ]|00)/g,
          );
          if (matches) {
            matches.forEach((match) => {
              const [, oldCommit, newCommit, version] =
                match.match(
                  /([0-9a-fA-F]+) ([0-9a-fA-F]+) refs\/tags\/(.*?)(?:[ ]|00)/,
                ) || [];
              if (oldCommit && newCommit && version) {
                const tagInfo: TagInfo = {
                  repo: repositoryName,
                  commit: newCommit,
                  version: version.replace(/\0+$/, ''),
                  accept: () => {
                    console.log(`[GitServer] Tag ${version} accepted`);
                  },
                  reject: (message = 'rejected') => {
                    console.log(
                      `[GitServer] Tag ${version} rejected: ${message}`,
                    );
                  },
                };
                this.emit('tag', tagInfo);
              }
            });
          }
          data = ''; // Clear processed data
        });
      }

      gitProcess.stderr.on('data', (data) => {
        console.error(`[GitServer] Git process stderr: ${data}`);
      });

      gitProcess.on('error', (error) => {
        console.error(`[GitServer] Git process error:`, error);
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end(`Git process error: ${error.message}`);
        }
      });

      gitProcess.on('close', (code) => {
        console.log(`[GitServer] Git process closed with code ${code}`);
        if (!response.headersSent) {
          if (code === 0) {
            response.end();
          } else {
            response.statusCode = 500;
            response.end(`Git process exited with code ${code}`);
          }
        }
      });

      // Setup the stream pipeline
      gitProcess.stdout.pipe(response);
      bufferedStream.pipe(gitProcess.stdin);
      bufferedStream.resume();
    };

    const handleReject = (message: string) => {
      if (accepted || rejected) return;
      rejected = true;

      console.log(
        `[GitServer] ${operationType} operation rejected: ${message}`,
      );
      response.statusCode = 500;
      response.setHeader('Content-Type', 'text/plain');
      response.end(message);
    };

    const info = {
      repo: repositoryName,
      accept: () => handleAccept(),
      reject: (message = 'rejected') => handleReject(message),
    };

    this.emit(operationType, info);

    // If no listeners, auto-accept immediately
    if (this.listenerCount(operationType) === 0) {
      handleAccept();
    }
  }

  private async handleHead(
    request: IncomingMessage,
    response: ServerResponse,
    repositoryName: string,
    repositoryPath: string,
  ): Promise<void> {
    console.log(`[GitServer] Handling HEAD for repo: ${repositoryName}`);

    try {
      console.log(
        `[GitServer] Checking repository existence: ${repositoryPath}`,
      );
      await fs.access(repositoryPath);
      console.log(`[GitServer] Repository exists`);
    } catch (error) {
      console.error(`[GitServer] Repository access error:`, error);
      response.statusCode = 404;
      response.end('Repository not found');
      return;
    }

    let accepted = false;
    let rejected = false;

    const handleAccept = () => {
      if (accepted || rejected) return;
      accepted = true;

      console.log(`[GitServer] HEAD request accepted`);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/plain');
      this.setNoCacheHeaders(response);
      response.end();
    };

    const handleReject = (message: string) => {
      if (accepted || rejected) return;
      rejected = true;

      console.log(`[GitServer] HEAD request rejected: ${message}`);
      response.statusCode = 403;
      response.setHeader('Content-Type', 'text/plain');
      response.end(message);
    };

    const info: GitInfo = {
      repo: repositoryName,
      accept: () => handleAccept(),
      reject: (message = 'rejected') => handleReject(message),
    };

    this.emit('head', info);

    // If no listeners, auto-accept immediately
    if (this.listenerCount('head') === 0) {
      handleAccept();
    }
  }

  private parseBasicAuth(request: IncomingMessage): {
    username?: string;
    password?: string;
  } {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return {};
    }

    const [type, credentials] = authHeader.split(' ');
    if (type !== 'Basic' || !credentials) {
      return {};
    }

    const [username, password] = Buffer.from(credentials, 'base64')
      .toString()
      .split(':');

    return { username, password };
  }

  private async authenticate(
    request: IncomingMessage,
    response: ServerResponse,
    operationType: 'push' | 'fetch',
    repositoryName: string,
  ): Promise<void> {
    if (!this.options.authenticate) {
      return;
    }

    const { username, password } = this.parseBasicAuth(request);

    try {
      await this.options.authenticate(
        operationType,
        repositoryName,
        username,
        password,
      );
    } catch (error) {
      response.setHeader('WWW-Authenticate', 'Basic realm="Git Server"');
      throw error;
    }
  }

  private async createRepo(repositoryPath: string): Promise<void> {
    console.log(
      `[GitServer] Creating new bare repository at: ${repositoryPath}`,
    );
    await fs.mkdir(repositoryPath, { recursive: true });

    try {
      console.log(`[GitServer] Initializing bare git repository`);
      await execa('git', ['init', '--bare', repositoryPath]);
      console.log(`[GitServer] Repository created successfully`);
    } catch (error) {
      console.error(`[GitServer] Repository creation failed:`, error);
      throw new Error(`Failed to create repository: ${String(error)}`);
    }
  }

  private getOperationType(gitServiceName: string): 'push' | 'fetch' {
    return gitServiceName === 'receive-pack' ? 'push' : 'fetch';
  }

  private setNoCacheHeaders(res: ServerResponse): void {
    res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
    res.setHeader('Expires', 'Fri, 01 Jan 1980 00:00:00 GMT');
  }
}
