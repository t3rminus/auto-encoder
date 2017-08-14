'use strict';

const Path = require('path'),
	Bluebird = require('bluebird'),
	ptn = require('parse-torrent-name'),
	MediaLookup = require('./lib/medialookup'),
	EncodeWatcher = require('./lib/encode-watcher'),
	os = require('os'),
	fs = require('fs-extra');

const padLeft = function(nr, n, str) { return (new Array(n-String(nr).length+1)).join(str||'0')+nr; };

const aac = process.platform === 'darwin' ? 'ca_aac' : 'av_aac';

const defaultConfig = {
	encodingSettings: {
		quality: 22,
		encoder: 'x264',
		audio: '%t',
		aencoder: aac,
		mixdown: 'stereo',
		ab: '192'
	},
	preferredLanguage: 'eng',
	minDuration: 120000,
	deleteWatch: false,
	deleteEncode: false,
	verbose: true
};

class Application {
	constructor() {
		if(process.env.DOCKER) {
			this.configFile = Path.resolve('/config/config.json');
		} else {
			this.configFile = Path.resolve('config.json');
		}
	}
	
	init() {
		return this.config = fs.ensureFile(this.configFile)
			.then(() => {
				return fs.readFile(this.configFile, 'utf8');
			})
			.then((data) => {
				if(!data) {
					return false;
				}
				try {
					return JSON.parse(data);
				} catch(e) {
					return false;
				}
			})
			.then((cfgData) => {
				if(!cfgData) {
					return fs.writeFile(this.configFile, JSON.stringify(defaultConfig))
						.then(() => {
							console.error('Missing or invalid configuration. Restored defaults.');
							process.exit(1);
						});
				}
				
				// If we're running in docker, ignore these configs
				// Will be mounted by the docker container
				if(process.env.DOCKER) {
					cfgData.watch = '/watch';
					cfgData.encode = '/encode';
					cfgData.output = '/output';
					cfgData.movies = '/movies';
					cfgData.tv = '/tv';
				}
				
				const dirPromises = [];
				if(!cfgData.watch) {
					console.error('Missing directory (config.watch)');
					process.exit(1);
				}
				cfgData.watch = Path.resolve(cfgData.watch);
				dirPromises.push(fs.ensureDir(cfgData.watch));
				if(!cfgData.encode) {
					console.error('Missing directory (config.encode)');
					process.exit(1);
				}
				cfgData.encode = Path.resolve(cfgData.encode);
				dirPromises.push(fs.ensureDir(cfgData.encode));
				
				if(cfgData.output && cfgData.movies && cfgData.tv) {
					cfgData.output = Path.resolve(cfgData.output);
					dirPromises.push(fs.ensureDir(cfgData.output));
					cfgData.movies = Path.resolve(cfgData.movies);
					dirPromises.push(fs.ensureDir(Path.resolve(cfgData.movies)));
					cfgData.tv = Path.resolve(cfgData.tv);
					dirPromises.push(fs.ensureDir(Path.resolve(cfgData.tv)));
				} else if(cfgData.output && cfgData.movies) {
					cfgData.output = Path.resolve(cfgData.output);
					dirPromises.push(fs.ensureDir(cfgData.output));
					cfgData.movies = Path.resolve(cfgData.movies);
					dirPromises.push(fs.ensureDir(Path.resolve(cfgData.movies)));
				} else if(cfgData.output && cfgData.tv) {
					cfgData.output = Path.resolve(cfgData.output);
					dirPromises.push(fs.ensureDir(cfgData.output));
					cfgData.tv = Path.resolve(cfgData.tv);
					dirPromises.push(fs.ensureDir(Path.resolve(cfgData.tv)));
				} else if(cfgData.tv && cfgData.movies) {
					cfgData.movies = Path.resolve(cfgData.movies);
					dirPromises.push(fs.ensureDir(cfgData.movies));
					cfgData.tv = Path.resolve(cfgData.tv);
					dirPromises.push(fs.ensureDir(Path.resolve(cfgData.tv)));
					cfgData.output = os.tmpdir();
				} else if(cfgData.output) {
					dirPromises.push(fs.ensureDir(Path.resolve(cfgData.output)));
				} else {
					console.error('Missing one or more output directories\n Need config.output, or config.movies and config.tv, or config.output and either config.movies or config.tv');
					process.exit(1);
				}
				
				return Bluebird.all(dirPromises)
					.then(() => {
						cfgData.verbose = cfgData.verbose !== false;
						return cfgData;
					})
					.catch((err) => {
						console.error('One or more directories could not be made/accessed.');
						console.error(err);
						process.exit(1);
					});
			});
	}
	run() {
		return this.config.then((config) => {
			this.lookup = new MediaLookup({
				mdbApiKey: config.mdbAPIKey || process.env.MDB_API
			});
			
			const settings = {
				watch: Path.resolve(config.watch),
				encode: Path.resolve(config.encode),
				complete: Path.resolve(config.output),
				encodingSettings: config.encodingSettings,
				surroundEncodingSettings: config.surroundEncodingSettings,
				sdEncodingSettings: config.sdEncodingSettings,
				preferredLanguage: config.preferredLanguage,
				minDuration: config.minDuration,
				deleteWatch: config.deleteWatch,
				deleteEncode: config.deleteEncode,
				verbose: config.verbose
			};
			
			this.encoder = new EncodeWatcher(settings);
			this.encoder.on('encoded', (file) => { this.sort(file); });
		});
	}
	
	sort(file) {
		this.config.then((config) => {
			const ext = Path.extname(file);
			const filename = Path.basename(file, ext);
			const fileInfo = ptn(filename);
			
			let sorted = Bluebird.resolve();
			if(config.movies) {
				sorted = sorted.then(() => {
					return fs.ensureDir(config.movies);
				});
			}
			if(config.tv) {
				sorted = sorted.then(() => {
					return fs.ensureDir(config.tv);
				});
			}
			
			return sorted.then(() => {
				if(fileInfo.season && fileInfo.episode && config.tv) {
					return this.lookup.getTVSeries(fileInfo.title)
						.then(series => {
							return this.lookup.getTVEpisode(series.tvMazeId, fileInfo.season, fileInfo.episode)
								.then(episode => { episode.series = series; return episode; });
						})
						.then((mediaInfo) => {
							const epNum = (''+mediaInfo.season) + padLeft(mediaInfo.episode, 2);
							const sortedName = epNum + ' - ' + mediaInfo.title + ext;
							const folderName = 'Season ' + mediaInfo.season;
							
							return fs.ensureDir(Path.join(config.tv, mediaInfo.series.title, folderName))
								.then(() => {
									return fs.move(file, Path.join(config.tv, mediaInfo.series.title, folderName, sortedName))
										.then(() => Path.join(mediaInfo.series.title, folderName, sortedName));
								});
						})
						.then((name) => {
							if(config.verbose) {
								console.log('Sorted', name);
							}
						})
						.catch(err => console.error(err));
				} else if(config.movies) {
					return this.lookup.getMovie(fileInfo.title, fileInfo.year)
						.then((mediaInfo) => {
							const name = mediaInfo.title + ext,
								yearName = mediaInfo.title + ' (' + mediaInfo.date.getUTCFullYear() +')' + ext;
							return fs.stat(Path.join(config.movies, name))
								.then(() => true, () => false)
								.then(exists => {
									if(exists) {
										return fs.move(file, Path.join(config.movies, yearName))
											.then(() => yearName);
									} else {
										return fs.move(file, Path.join(config.movies, name))
											.then(() => name);
									}
								})
						})
						.then((name) => {
							if(config.verbose) {
								console.log('Sorted', name);
							}
						})
						.catch(err => console.error(err));
				}
			});
		});
	}
}

const app = new Application();
app.init()
	.then(() => {
		return app.run();
	})
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});