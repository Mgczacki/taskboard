const { Worker, isMainThread } = require('node:worker_threads');
const { createHash } = require('node:crypto');

if (isMainThread) {
  for (let i = 0; i < 2; i++) new Worker(__filename);
  console.log('Controlled test load: 2 CPU workers, 64 MiB touched in each worker.');
} else {
  const data = Buffer.alloc(64 * 1024 * 1024, 1);
  let step = 0;
  function work() {
    for (let i = 0; i < data.length; i += 4096) data[i] = (data[i] + 1) & 255;
    createHash('sha256').update(data).digest();
    if (++step % 8 === 0) setImmediate(work);
    else work();
  }
  work();
}
