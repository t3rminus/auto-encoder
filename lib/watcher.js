import { EventEmitter } from 'events';
import { resolve } from 'path';
import chokidar from 'chokidar';
import { mkdir } from 'fs/promises';

export default class Watcher extends EventEmitter {
  constructor(path) {
    super();
    const fullPath = resolve(path);

    (async () => {
      await mkdir(fullPath, { recursive: true });

      this.addWatcher = chokidar.watch(fullPath, {
        ignored: /(^|[\/\\])\../,
        persistent: true
      });

      this.addWatcher.on('add', (file) => {
        this.emit('file', file);
      });
    })();
  }
}