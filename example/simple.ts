import { GitServer } from '../src/gitserver.js';
import { join } from 'path';

const { PORT } = process.env;

const port = typeof PORT === 'string' ? parseInt(PORT) : 7005;

const repos = new GitServer(join(__dirname, '../repo'), {
  autoCreate: true,
});

repos.on('push', (push) => {
  console.log(`push ${push.repo}/${push.commit} ( ${push.branch} )`);
  push.accept();
});

repos.on('fetch', (fetch) => {
  console.log(`fetch ${fetch.commit}`);
  fetch.accept();
});

repos.listen(port);
