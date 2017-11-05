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
	ProgressBar = require('progress'),
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
		
		this.extractQueue = new Queue(this.extractFile.bind(this), { maxRetries: 10, retryDelay: 30000 });
		this.encodeQueue = new Queue(this.encodeFile.bind(this));
		
		this.extractQueue.on('task_failed', (taskId, err, stats) => {
			this._log('Extraction failed', err, stats);
		});
		this.encodeQueue.on('task_failed', (taskId, err, stats) => {
			this._log('Encoding failed', err, stats);
		});
		
		this.addWatcher = chokidar.watch(this.addDir, {
			ignored: /(^|[\/\\])\../,
			cwd: this.addDir,
			persistent: true
		});
		this.addWatcher.on('add', (path) => {
			const fullPath = Path.join(this.addDir, path);
			this.db.files.insert({ file: fullPath })
			.then(() => {
				if(isFunction(this.opts.onAdd)) {
					return Bluebird.resolve(this.opts.onAdd(path))
						.then((result) => {
							if(result || result === undefined) {
								this.extractQueue.push(path);
							}
						});
				} else {
					this.extractQueue.push(path);
				}
			})
			.catch((err) => {
				if(err.errorType === 'uniqueViolated') {
					this._log('Ignoring, already processed: ', fullPath);
					return;
				}
				throw err;
			});
		});
		this._log('Watching for compressed media in', this.addDir);
	}
	
	extractFile(path, cb) {
		const fullPath = Path.join(this.addDir, path);
		const ext = Path.extname(path).replace(/^\./,'');
		
		Bluebird.try(() => {
			if(ext === 'rar' && (!/part[0-9]+\.rar/.test(path)) || /part0*1\.rar/.test(path)) {
				return this._handleRar(fullPath);
			} else if(ext === 'zip') {
				return this._handleZip(fullPath);
			} else if(EncodeWatcher._isMedia(path)) {
				this._log('Noticed', path);
				return this._handleFile(fullPath);
			}
		})
		.nodeify(cb);
	}
	
	_log() {
		if(this.opts.verbose) {
			console.log.apply(null, Array.prototype.slice.call(arguments));
		}
	}
	
	static _isMedia(path) {
		return /\.(3g2|3gp|3gpp|asf|avi|divx|f4v|flv|h264|ifo|m2ts|m4v|mkv|mod|mov|mp4|mpeg|mpg|mswmm|mts|mxf|ogv|rm|srt|swf|ts|vep|vob|webm|wlmp|wmv)$/
			.test(path);
	}
	
	_handleRar(path) {
		const files = [];
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
				.then(() => {
					files.push(out);
				});
			})
			.then(() => {
				this._log('Extracted RAR', Path.basename(path));
			})
			.then(() => {
				return Bluebird.map(files, (file) => {
					return Bluebird.fromCallback((cb) => {
						this.encodeQueue.push({ file: file, extracted: true }, cb);
					});
				});
			})
			.then(() => {
				if(this.opts.deleteWatch) {
					return this._deleteFolder(path);
				}
			});
		});
	}
	
	_handleZip(path) {
		const files = [];
		return Bluebird.try(() => {
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
				this._log('Extracted ZIP', Path.basename(path));
			})
			.then(() => {
				return Bluebird.map(files, (file) => {
					return Bluebird.fromCallback((cb) => {
						this.encodeQueue.push({ file: file, extracted: true }, cb);
					});
				});
			})
			.then(() => {
				if(this.opts.deleteWatch) {
					return this._deleteFolder(path);
				}
			});
		});
	}
	
	_handleFile(path) {
		return Bluebird.fromCallback((cb) => {
			this.encodeQueue.push({ file: path, extracted: false }, cb);
		})
		.then(() => {
			if(this.opts.deleteWatch) {
				return this._deleteFolder(path);
			}
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
		let bestTrac = trax[0], trackNum = 0;
		for(let i = 0; i < trax.length; i++) {
			const trac = trax[i];
			if((trac.lang === this.opts.preferredLanguage && trac.ch >= bestTrac.ch)
				|| (bestTrac.lang !== this.opts.preferredLanguage &&  trac.ch >= bestTrac.ch)) {
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
	
	encodeFile(item, cb) {
		const path = item.file;
		const extracted = item.extracted;
		const filename = Path.basename(path, Path.extname(path));
		
		mimovie(path)
		.then((mediaInfo) => {
			if(!mediaInfo) {
				throw new Error('No media information ', path, mediaInfo);
			}
			if(this.opts.minDuration && mediaInfo.general.duration < this.opts.minDuration) {
				if(this.opts.deleteEncode) {
					this._log('Deleting Sample (too short)',filename);
					return fs.unlink(path).catch(() => { /* ignore errors */ });
				} else {
					this._log('Ignoring Sample (too short)',filename);
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
				throw new Error('No video tracks present in file', path);
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
			
			return Bluebird.fromNode((cb) => {
					const bar = new ProgressBar(':file [:bar] :percent', { total: 100, width: 20 });
					hbjs.spawn(settings)
						.on('error', cb)
						.on('progress', (progress) => {
							bar.tick(progress.percentComplete, { file: filename });
						})
						.on('end', () => { cb(); });
				})
				.then(() => {
					this.emit('encoded', settings.output);
					
					if(extracted && this.opts.deleteEncode) {
						return fs.unlink(settings.input).catch(() => { /* ignore errors */ });
					}
				});
		})
		.nodeify(cb);
	}
}

module.exports = EncodeWatcher;