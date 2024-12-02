import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { IncomingMessage, ServerResponse } from 'http';
import { PassThrough } from 'stream';
import { GitServer } from './gitserver.js';
import { noCache } from './util.js';

export class Service extends EventEmitter {
  private req: IncomingMessage;
  private res: ServerResponse;
  private repoName: string;
  private repoPath: string;
  private serviceName: string;
  private type: 'push' | 'fetch';
  private gitServer: GitServer;
  private accepted = false;
  private rejected = false;
  private buffered: PassThrough;

  constructor(
    req: IncomingMessage,
    res: ServerResponse,
    repoName: string,
    repoPath: string,
    serviceName: string,
    gitServer: GitServer,
  ) {
    super();
    this.req = req;
    this.res = res;
    this.repoName = repoName;
    this.repoPath = repoPath;
    this.serviceName = serviceName;
    this.type = serviceName === 'receive-pack' ? 'push' : 'fetch';
    this.gitServer = gitServer;

    // Create a paused buffer for request data
    this.buffered = new PassThrough();
    this.req.pipe(this.buffered);
    this.buffered.pause();

    // Set up event handlers in constructor
    this.once('accepted', () => {
      console.log(
        `[Service] ${this.type} operation accepted, spawning git process`,
      );

      process.nextTick(() => {
        const args = [this.serviceName, '--stateless-rpc', this.repoPath];
        console.log(
          `[Service] Spawning git process with command: git ${args.join(' ')}`,
        );

        const gitProcess = spawn('git', args);

        this.res.setHeader(
          'Content-Type',
          `application/x-git-${this.serviceName}-result`,
        );
        noCache(this.res);

        gitProcess.stderr.on('data', (data) => {
          console.error(`[Service] Git process stderr: ${data}`);
        });

        gitProcess.stdout.on('data', (data) => {
          console.log(`[Service] Git process stdout: ${data}`);
        });

        gitProcess.on('error', (error) => {
          console.error(`[Service] Git process error:`, error);
          console.error(`[Service] Error stack:`, error.stack);
          this.emit('error', error);
        });

        gitProcess.on('close', (code, signal) => {
          console.log(
            `[Service] Git process closed with code ${code} and signal ${signal}`,
          );
          if (code === 0) {
            // Send git protocol termination
            this.res.write(Buffer.from('0000'));
            this.res.end();
            this.emit('end');
          } else {
            this.emit(
              'error',
              new Error(`Git process exited with code ${code}`),
            );
          }
        });

        // Setup the stream pipeline
        gitProcess.stdout.pipe(this.res);
        this.buffered.pipe(gitProcess.stdin);
        this.buffered.resume();
      });
    });

    this.once('rejected', (message: string) => {
      console.log(`[Service] ${this.type} operation rejected: ${message}`);
      this.res.statusCode = 500;
      this.res.end(message);
      this.emit('end');
    });

    console.log(
      `[Service] Initialized ${this.type} service for repo: ${this.repoName}, path: ${this.repoPath}`,
    );
  }

  public async execute(): Promise<void> {
    console.log(`[Service] Starting execution of ${this.type} operation`);
    console.log(`[Service] Request headers:`, this.req.headers);
    console.log(`[Service] Request method: ${this.req.method}`);
    console.log(`[Service] Request URL: ${this.req.url}`);

    const info = {
      repo: this.repoName,
      accept: this.accept.bind(this),
      reject: this.reject.bind(this),
    };

    console.log(`[Service] Emitting ${this.type} event to GitServer`);
    this.gitServer.emit(this.type, info);

    // Auto-accept after a timeout if not accepted or rejected
    setTimeout(() => {
      if (!this.accepted && !this.rejected) {
        console.log(
          `[Service] Auto-accepting ${this.type} operation after timeout`,
        );
        this.accept();
      }
    }, 1000);

    // Wait for completion
    return new Promise((resolve, reject) => {
      this.once('end', resolve);
      this.once('error', reject);
    });
  }

  private accept(): void {
    if (this.accepted || this.rejected) {
      console.log(
        `[Service] Ignoring accept() call - already ${this.accepted ? 'accepted' : 'rejected'}`,
      );
      return;
    }
    console.log(`[Service] Accepting ${this.type} operation`);
    this.accepted = true;
    this.emit('accepted');
  }

  private reject(message = 'rejected'): void {
    if (this.accepted || this.rejected) {
      console.log(
        `[Service] Ignoring reject() call - already ${this.accepted ? 'accepted' : 'rejected'}`,
      );
      return;
    }
    console.log(`[Service] Rejecting ${this.type} operation: ${message}`);
    this.rejected = true;
    this.emit('rejected', message);
  }
}
