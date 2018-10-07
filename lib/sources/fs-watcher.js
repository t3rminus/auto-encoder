const { EventEmitter } = require('events');
const Chokidar = require('chokidar');
const fs = require('fs-extra');
const Path = require('path');

class FsWatcherSource extends EventEmitter {
	constructor(config) {
		super();
		
		if(process.env.AE_WATCH_DIR) {
			this.watch = Path.resolve(process.env.AE_WATCH_DIR);
		} else if(process.env.DOCKER) {
			this.watch = Path.resolve('/watch');
		} else {
			this.watch = Path.resolve(config.watch);
		}
	}
	
	async init() {
		await fs.ensureDir(this.watch);
		
		this.addWatcher = Chokidar.watch(this.watch, {
			ignored: /(^|[\/\\])\../,
			cwd: this.watch,
			persistent: true
		});
		
		this.addWatcher.on('add', (path) => this.emit('file', Path.join(this.watch, path)));
	}
}

module.exports = FsWatcherSource;