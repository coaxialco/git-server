// src/service.ts

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { IncomingMessage, ServerResponse } from 'http';
import { PassThrough } from 'stream';
import { GitServer } from './gitserver.js';

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
  }

  public async execute(): Promise<void> {
    const buffered = new PassThrough();
    this.req.pipe(buffered);

    let infoParsed = false;
    let initialData = Buffer.alloc(0);

    buffered.on('data', (chunk) => {
      if (!infoParsed) {
        initialData = Buffer.concat([initialData, chunk]);
        const str = initialData.toString();

        if (str.includes('\n')) {
          infoParsed = true;
          // We only need to check if the data contains a newline to confirm it's complete
          str.split('\n');

          const info = {
            repo: this.repoName,
            // commit: ...,
            // branch: ...,
            accept: this.accept.bind(this),
            reject: this.reject.bind(this),
          };

          this.gitServer.emit(this.type, info);

          setTimeout(() => {
            if (!this.accepted && !this.rejected) {
              this.accept();
            }
          }, 100);
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      const gitProcess = spawn('git', [
        this.serviceName,
        '--stateless-rpc',
        this.repoPath,
      ]);

      gitProcess.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
      });

      gitProcess.on('error', (error) => {
        console.error(`error: ${error.message}`);
        reject(error);
      });

      gitProcess.on('close', () => {
        this.res.end();
        resolve();
      });

      this.on('accepted', () => {
        buffered.pipe(gitProcess.stdin);
        gitProcess.stdout.pipe(this.res);
      });

      this.on('rejected', (message: string) => {
        this.res.statusCode = 500;
        this.res.end(message);
        resolve();
      });
    });
  }

  private accept() {
    if (this.accepted || this.rejected) return;
    this.accepted = true;
    this.emit('accepted');
  }

  private reject(message: string) {
    if (this.accepted || this.rejected) return;
    this.rejected = true;
    this.emit('rejected', message);
  }
}
