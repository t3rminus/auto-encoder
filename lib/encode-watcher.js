'use strict';

const EventEmitter = require('events'),
	Bluebird = require('bluebird'),
	Queue = require('better-queue'),
	fs = require('fs-extra'),
	Path = require('path'),
	chokidar = require('chokidar'),
	Unrar = require('unrar'),
	Unzip = require('unzipper'),
	mimovie = Bluebird.promisify(require('mimovie')),
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
			persistent: true,
			awaitWriteFinish: {
				stabilityThreshold: 5000,
				pollInterval: 500
			}
		});
		this.addWatcher.on('add', (path) => {
			if(isFunction(this.opts.onAdd)) {
				Bluebird.resolve(this.opts.onAdd(path))
					.then((result) => {
						if(result || result === undefined) {
							this.extractQueue.push(path);
						}
					});
			} else {
				this.extractQueue.push(path);
			}
		});
		this._log('Watching for compressed media in', this.addDir);
		this.recentExtracts = {};
		
		this.encodeWatcher = chokidar.watch(this.encodeDir, {
			ignored: /(^|[\/\\])\../,
			cwd: this.encodeDir,
			persistent: true,
			awaitWriteFinish: {
				stabilityThreshold: 5000,
				pollInterval: 500
			}
		});
		this.encodeWatcher.on('add', (path) => {
			if(isFunction(this.opts.onEncode)) {
				Bluebird.resolve(this.opts.onEncode(path))
					.then((result) => {
						if(result || result === undefined) {
							this.encodeQueue.push(path)
						}
					});
			} else {
				this.encodeQueue.push(path)
			}
		});
		this._log('Watching for extracted media in', this.encodeDir);
		this.recentEncodes = {};
	}
	
	extractFile(path, cb) {
		const fullPath = Path.join(this.addDir, path);
		const ext = Path.extname(path).replace(/^\./,'');
		
		// Ignore messages for ~4h
		if(this.recentExtracts[path]) {
			cb();
		}
		this.recentExtracts[path] = setTimeout(() => {
			delete this.recentExtracts[path];
		}, 21600000); // 6H in MS
		
		if(ext === 'rar' && (!/part[0-9]+\.rar/.test(path)) || /part0*1\.rar/.test(path)) {
			this._log('Noticed', path);
			this._handleRar(fullPath, cb);
		} else if(ext === 'zip') {
			this._log('Noticed', path);
			this._handleZip(fullPath, cb);
		} else if(EncodeWatcher._isMedia(path)) {
			this._log('Noticed', path);
			this._handleFile(fullPath, cb);
		} else {
			cb();
		}
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
	
	_handleRar(path, cb) {
		const arch = new Unrar(path);
		arch.list((err, items) => {
			if(err) { return cb(err); }
			
			items = items.filter((item) => {
				return item.type === 'File' && EncodeWatcher._isMedia(item.name);
			});
			
			Bluebird.map(items, (item) => {
					return Bluebird.fromNode((cb) => {
						arch.stream(item.name)
							.pipe(fs.createWriteStream(Path.join(this.encodeDir, Path.basename(item.name))))
							.on('error', (err) => { cb(err); })
							.on('finish', () => { cb(); });
					});
				})
				.then(() => {
					this._log('Extracted RAR', Path.basename(path));
					if(this.opts.deleteWatch) {
						return this._deleteFolder(path);
					}
				})
				.nodeify(cb);
		});
	}
	
	_handleZip(path, cb) {
		fs.createReadStream(path)
			.pipe(Unzip.Parse())
			.on('entry', (item) => {
				if(EncodeWatcher._isMedia(item.path) && item.type === 'File') {
					item.pipe(fs.createWriteStream(Path.join(this.encodeDir, Path.basename(item.path))));
				} else {
					item.autodrain();
				}
			})
			.promise()
			.then(() => {
				this._log('Extracted ZIP', Path.basename(path));
				if(this.opts.deleteWatch) {
					return this._deleteFolder(path);
				}
			})
			.nodeify(cb);
	}
	
	_handleFile(path, cb) {
		fs.copy(path, Path.join(this.encodeDir, Path.basename(path)))
			.then(() => {
				this._log('Copied', Path.basename(path));
				if(this.opts.deleteWatch) {
					return this._deleteFolder(path);
				}
			})
			.nodeify(cb);
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
	
	encodeFile(path, cb) {
		path = Path.join(this.encodeDir, path);
		const filename = Path.basename(path, Path.extname(path));
		
		// Ignore messages for ~6h
		if(this.recentEncodes[path]) {
			cb();
		}
		this.recentEncodes[path] = setTimeout(() => {
			delete this.recentEncodes[path];
		}, 21600000); // 6H in MS
		
		// Start by waiting 5s so we don't get ahead of the copier.(which happens, apparently, even with awaitWriteFinish)
		Bluebird.delay(5000)
			.then(() => {
				return mimovie(path);
			})
			.then((mediaInfo) => {
				if(!mediaInfo) {
					throw new Error('No media information ', path, mediaInfo);
				}
				if(!this.opts.minDuration || mediaInfo.general.duration > this.opts.minDuration) {
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
					
					this._log('Encoding',filename, settings);
					
					return Bluebird.fromNode((cb) => {
							let lastPct = 0;
							hbjs.spawn(settings)
								.on('error', cb)
								.on('progress', (progress) => {
									const cpt = Math.round(progress.percentComplete);
									if(lastPct !== cpt) {
										lastPct = cpt;
										this._log('Encoding', filename+':', Math.round(progress.percentComplete) + '%');
									}
								})
								.on('end', () => { cb(); });
						})
						.then(() => {
							this.emit('encoded', settings.output);
							if(this.opts.deleteEncode) {
								return Bluebird.fromNode((cb) => {
									fs.unlink(settings.input, cb).catch(() => { /* ignore errors */ });
								});
							}
						});
				} else {
					if(this.opts.deleteEncode) {
						this._log('Deleting Sample (too short)',filename);
						return Bluebird.fromNode((cb) => {
							fs.unlink(path, cb).catch(() => { /* ignore errors */ });
						});
					} else {
						this._log('Ignoring Sample (too short)',filename);
					}
				}
			})
			.nodeify(cb);
	}
}

module.exports = EncodeWatcher;