'use strict';

const EventEmitter = require('events'),
	Bluebird = require('bluebird'),
	Queue = require('better-queue'),
	fs = require('fs-extra'),
	Path = require('path'),
	Datastore = require('nedb-promise'),
	chokidar = require('chokidar'),
	Unrar = require('unrar'),
	Unzip = require('unzipper'),
	mimovie = Bluebird.promisify(require('mimovie')),
	glob = require('glob-promise'),
	hbjs = require('handbrake-js');

function isFunction(functionToCheck) {
	return functionToCheck && Object.prototype.toString.call(functionToCheck) === '[object Function]';
}

class EncodeWatcher extends EventEmitter {
	constructor(options) {
		super();
		if(!options.watch) {
			throw new Error('Watch directory missing from options');
		}
		if(!options.encode) {
			throw new Error('Encode directory missing from options');
		}
		if(!options.complete) {
			throw new Error('Complete directory missing from options');
		}
		this.addDir = options.watch;
		this.encodeDir = options.encode;
		this.outDir = options.complete;
		this.opts = options;
		
		this.db = {};
		
		this.db.files = new Datastore({ filename: Path.join(options.configDir, 'files.db'), autoload: true });
		this.db.files.ensureIndex({ fieldName: 'file', unique: true }, (err) => {
			if(err) { console.error(err); process.exit(1); }
		});
		
		this.processQueue = new Queue(this.process.bind(this), {
				id: 'path',
				concurrent: 1,
				batchSize: 1,
				// This will ignore subsequent adds with the same ID.
				merge: (oldTask, newTask, cb) => cb()
			});
		this.processQueue.on('task_failed', (taskId, err, stats) => {
			console.error(`Processing failed for\n\t${taskId}\n\n${JSON.stringify(err,null,4)}` +
		 		`\n\n${JSON.stringify(stats,null,4)}\n\n`);
		});
		
		this.addWatcher = chokidar.watch(this.addDir, {
			ignored: /(^|[\/\\])\../,
			cwd: this.addDir,
			persistent: true
		});
		
		this.addWatcher.on('add', (path) => this.processQueue.push({ path }));
		
		// Manually glob them every 15 minutes as backup.
		setInterval(() => {
			glob('**/*', { cwd: this.addDir, nodir: true })
				.then(result => result.map(path => this.processQueue.push({ path })));
		}, 900000);
		
		this._log('Watching for compressed media in', this.addDir);
	}
	
	
	process(srcObject, cb) {
		if(!srcObject.path) {
			cb(new Error('Missing path in process queue'));
		}
		
		srcObject.fullPath = Path.join(this.addDir, srcObject.path);
		Bluebird.try(() => {
			return this.db.files.find({ file: srcObject.fullPath })
			.then((result) => {
				if(!result || !result.length) {
					this._log('Noticed ' + srcObject.path);
					// Extract files and try and encode them!
					this.extractFile(srcObject.fullPath)
						.then((files) => {
							if(files && Array.isArray(files)){
								return Bluebird.map(files, file => {
									if(isFunction(this.opts.onAdd)) {
										return Bluebird.resolve(this.opts.onAdd(file))
										.then((result) => {
											if(result || result === undefined) {
												return this.encodeFile(file);
											}
										});
									} else {
										return this.encodeFile(file);
									}
								}, { concurrency: 1 })
								.then(() => {
									// Insert the file into the DB
									return this.db.files.insert({ file: srcObject.fullPath })
									.catch(() => { /* ignore */ })
								});
							}
						})
						.then(() => {
							// Insert the file into the DB
							return this.db.files.insert({ file: srcObject.fullPath })
							.catch(() => { /* ignore */ })
						})
				}
			});
		})
		.asCallback(cb);
	}
	
	extractFile(path) {
		const ext = Path.extname(path).replace(/^\./,'');
		
		return Bluebird.try(() => {
			if(ext === 'rar' && (!/part[0-9]+\.rar/.test(path)) || /part0*1\.rar/.test(path)) {
				return this._handleRar(path);
			} else if(ext === 'zip') {
				return this._handleZip(path);
			} else if(EncodeWatcher._isMedia(path)) {
				return this._handleFile(path);
			} else {
				this._log(`Unknown extension: ${Path.basename(path)}`);
			}
		});
	}
	
	_log() {
		if(this.opts.verbose) {
			const out = Array.prototype.slice.call(arguments)
				.map((arg) => (arg && arg.toString() ? arg.toString() : arg))
				.join(' ');
			process.stdout.write(`${out}\r\n`);
		}
	}
	
	_logWrite() {
		if(this.opts.verbose) {
			const out = Array.prototype.slice.call(arguments)
				.map((arg) => (arg && arg.toString() ? arg.toString() : arg))
				.join(' ');
			process.stdout.write(out);
		}
	}
	
	static _isMedia(path) {
		return /\.(3g2|3gp|3gpp|asf|avi|divx|f4v|flv|h264|ifo|m2ts|m4v|mkv|mod|mov|mp4|mpeg|mpg|mswmm|mts|mxf|ogv|rm|srt|swf|ts|vep|vob|webm|wlmp|wmv)$/
			.test(path);
	}
	
	_handleRar(path) {
		const arch = Bluebird.promisifyAll(new Unrar(path));
		
		return arch.listAsync()
		.then((items) => {
			items = items.filter((item) => {
				return item.type === 'File' && EncodeWatcher._isMedia(item.name);
			});
			
			return Bluebird.map(items, (item) => {
				const out = Path.join(this.encodeDir, Path.basename(item.name));
				return Bluebird.fromCallback((cb) => {
					arch.stream(item.name)
						.pipe(fs.createWriteStream(out))
						.on('error', (err) => { cb(err); })
						.on('finish', () => { cb(); });
				})
				.then(() => out);
			})
			.then((files) => {
				this._log(`Extracted RAR ${Path.basename(path)}`);
				return files;
			})
			.then((files) => {
				if(this.opts.deleteWatch) {
					return this._deleteFolder(path)
						.then(() => files);
				}
				return files;
			});
		});
	}
	
	_handleZip(path) {
		return Bluebird.try(() => {
			const files = [];
			
			return fs.createReadStream(path)
			.pipe(Unzip.Parse())
			.on('entry', (item) => {
				if(EncodeWatcher._isMedia(item.path) && item.type === 'File') {
					const out = Path.join(this.encodeDir, Path.basename(item.path));
					files.push(out);
					item.pipe(fs.createWriteStream(out));
				} else {
					item.autodrain();
				}
			})
			.promise()
			.then(() => {
				this._log(`Extracted ZIP ${Path.basename(path)}`);
				return files;
			})
			.then((files) => {
				if(this.opts.deleteWatch) {
					return this._deleteFolder(path)
					.then(() => files);
				}
				return files;
			});
		});
	}
	
	_handleFile(path) {
		return Bluebird.try(() => {
			if(this.opts.deleteWatch) {
				return this._deleteFolder(path)
					.then(() => [path]);
			}
			
			return [path];
		});
	}
	
	_deleteFolder(path) {
		const dir = Path.dirname(path);
		const ext = Path.extname(path);
		let filename = Path.basename(path, ext);
		if(ext === '.rar') {
			filename = filename.replace(/part[0-9]+$/,'');
		}
		
		return Bluebird.fromNode((cb) => { fs.readdir(dir,cb); })
			.then((items) => {
				const unrelatedItems = items.filter((item) => {
					const itemExt = Path.extname(path);
					let itemFilename = Path.basename(path, ext);
					if(itemExt === '.rar') {
						itemFilename = itemFilename.replace(/part[0-9]+$/,'');
					}
					return !/\.(nfo|sfv|jpg|txt)$/i.test(item)
						&& !/^(proof|sample|cover|subs|screens|readme)/ig.test(item)
						&& itemFilename !== filename;
				});
				if(!unrelatedItems.length && dir !== this.addDir) {
					// In a folder without any unrelated items. Delete the whole folder
					return fs.remove(dir).catch(() => { /* ignore errors */ });
				} else {
					// There were possibly unrelated items. Just delete this one file.
					return fs.remove(path).catch(() => { /* ignore errors */ });
				}
			});
	}
	
	_bestAudio(trax) {
		if(!trax || !trax.length) {
			return false;
		}
		
		const lang = this.opts.preferredLanguage;
		let bestTrac = trax[0], trackNum = 0;

		for(let i = 0; i < trax.length; i++) {
			const trac = trax[i];
			if(trac.lang === lang && trac.default && !bestTrac.default) {
				bestTrac = trac;
				trackNum = i;
			} else if(trac.lang === lang && !bestTrac.default && trac.ch > bestTrac.ch) {
				bestTrac = trac;
				trackNum = i;
			} else if(trac.lang === lang && bestTrac.lang !== lang) {
				bestTrac = trac;
				trackNum = i;
			} else if(trac.ch > bestTrac.ch && bestTrac.lang !== lang) {
				bestTrac = trac;
				trackNum = i;
			}
		}
		return { i: trackNum, track: bestTrac };
	}
	_bestVideo(trax) {
		if(!trax || !trax.length) {
			return false;
		}
		let bestTrac = trax[0], trackNum = 0;
		for(let i = 0; i < trax.length; i++) {
			const trac = trax[i];
			if(trac.width * trac.height > bestTrac.width * bestTrac.height) {
				bestTrac = trac;
				trackNum = i;
			}
		}
		return { i: trackNum, track: bestTrac };
	}
	
	encodeFile(path) {
		const filename = Path.basename(path, Path.extname(path));

		return mimovie(path)
		.then((mediaInfo) => {
			if(!mediaInfo) {
				throw new Error(`No media information ${path}:\n${JSON.stringify(mediaInfo,null,4)}\n\n`);
			}
			
			if(this.opts.minDuration && mediaInfo.general.duration < this.opts.minDuration) {
				if(this.opts.deleteEncode) {
					this._log(`Deleting Sample (too short)\n\t${filename}\n`);
					return fs.unlink(path).catch(() => { /* ignore errors */ });
				} else {
					this._log(`Ignoring Sample (too short)\n\t${filename}\n`);
					return;
				}
			}
			
			let out = Path.join(this.outDir, filename + '.' + (this.opts.outputFormat || 'mp4'));
			const audioTrack = this._bestAudio(mediaInfo.audio);
			const videoTrack = this._bestVideo(mediaInfo.video);
			const settings = Object.assign({}, this.opts.encodingSettings || {}, { input: path, output: out });
			
			if(videoTrack) {
				if(videoTrack.height < 720) {
					Object.assign(settings, this.opts.sdEncodingSettings || {});
				}
			} else {
				throw new Error(`No video tracks present in file: \n\t${path}\n`);
			}
			
			if(audioTrack) {
				if(audioTrack.track.ch > 2) {
					Object.assign(settings, this.opts.surroundEncodingSettings || {});
				}
				settings.audio = settings.audio.replace(/%t/g, audioTrack.i + 1);
			} else {
				const audioSettings = ['audio-lang-list','all-audio','first-audio','audio','aencoder',
					'audio-copy-mask','audio-fallback','ab','aq','ac','mixdown','normalize-mix',
					'arate','drc','gain','adither','aname'];
				audioSettings.forEach((setting) => { delete settings[setting]; });
			}
			
			if(settings.format) {
				delete settings.format;
			}
			
			return Bluebird.fromCallback((cb) => {
				this._log(`Encoding ${filename}`);
				let dotProgress = [0,20,40,60,80,100];
				hbjs.spawn(settings)
					.on('error', cb)
					.on('progress', (progress) => {
						if(progress.percentComplete > dotProgress[0]) {
							const curPercent = dotProgress.shift();
							this._log(`${curPercent}%`);
						}
					})
					.on('end', () => { cb(); });
			})
			.then(() => {
				this._log(`Done.`);
				if(isFunction(this.opts.onDone)) {
					return Bluebird.resolve(this.opts.onDone(settings.output, settings.input));
				}
			})
			.then(() => {
				if(this.opts.deleteEncode && settings.input.indexOf(this.opts.encode) === 0) {
					return fs.unlink(settings.input).catch(() => { /* ignore errors */ });
				}
			});
		});
	}
}

module.exports = EncodeWatcher;