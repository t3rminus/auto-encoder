'use strict';

const Path = require('path'),
	Bluebird = require('bluebird'),
	ptn = require('parse-torrent-name'),
	MediaLookup = require('./lib/medialookup'),
	EncodeWatcher = require('./lib/encode-watcher'),
	diacritics = require('./lib/diacritics'),
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
		
		this.sortCache = [];
		this.checkCache = [];
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
					return fs.writeFile(this.configFile, JSON.stringify(defaultConfig, null, 4))
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
				verbose: config.verbose,
				outputFormat: config.outputFormat,
				onAdd: (path) => this.check(path)
			};
			
			this.encoder = new EncodeWatcher(settings);
			this.encoder.on('encoded', (file) => this.sort(file) );
		});
	}
	
	check(file) {
		const ext = Path.extname(file);
		const fileName = Path.basename(file, ext);
		
		if(/^sample-/.test(fileName)) {
			console.info('Ignoring encode for file -- sample', fileName);
			return false;
		}
		
		const cached = this.checkCache.find(c => c.fileName === fileName);
		if(cached) {
			return cached.output;
		}
		
		const output = this.getOutputFile(file)
			.then((sortedFile) => {
				// Check if the sorted result file already exists.
				return fs.stat(sortedFile);
			})
			// If it does, return false (don't process)
			.then(() => {
				console.info('Ignoring encode for file -- already exists', fileName);
				return false;
			})
			.catch(() => true);
		
		if(this.checkCache.length > 300) {
			this.checkCache = this.checkCache.slice(0, 299);
		}
		
		this.checkCache.push({ fileName: fileName, output: output });
		return output;
	}
	
	sort(file) {
		return this.getOutputFile(file)
			.then(function(resultName) {
				const path = Path.dirname(resultName);
				const filename = Path.basename(resultName);
				
				return fs.ensureDir(path)
					.then(() => {
						return fs.move(file, resultName);
					})
					.then(() => {
						console.log('Sorted ', filename);
					});
			})
			.catch((err) => {
				console.error('An error occurred sorting file', file);
				console.error(err);
			});
	}
	
	getOutputFile(path) {
		const ext = Path.extname(path);
		const fileName = Path.basename(path, ext);
		
		const cached = this.sortCache.find(c => c.fileName === fileName);
		if(cached) {
			return cached.output;
		}

		const output = this.lookupOutputFile(path);
		
		if(this.sortCache.length > 300) {
			this.sortCache = this.sortCache.slice(0, 299);
		}
		
		this.sortCache.push({ fileName: fileName, output: output });
		return output;
	}
	
	lookupOutputFile(path) {
		const ext = Path.extname(path);
		const fileName = Path.basename(path, ext);
		const fileInfo = ptn(fileName);
		
		return this.config.then((config) => {
			let outputExt = (config.outputFormat || 'mp4');
			if(!/^\./.test(outputExt)) {
				outputExt = '.' + outputExt;
			}

			let result;
			if(fileInfo.season && fileInfo.episode && config.tv) {
				result = this.lookup.getTVSeriesOptions(fileInfo.title, fileInfo.year)
				.then((options) => {
					if(!options.length) {
						throw new Error('No TV series matches for ' + fileInfo.title);
					}
					
					const probableOptions = options.filter((o) => o.matchProbability > 0.75)
					.sort((a,b) => b.matchRanking - a.matchRanking);
					
					if(!probableOptions.length) {
						throw new Error('An error occurred filtering TV series results for ' + fileInfo.title);
					}
					
					const series = probableOptions[0];
					return this.lookup.getTVEpisode(series.tvMazeId, fileInfo.season, fileInfo.episode)
					.then(episode => { episode.series = series; return episode; })
					.then((mediaInfo) => {
						if(!mediaInfo) {
							throw new Error('No TV episode matches for ' + fileName);
						}
						
						const seriesName = this.cleanName(mediaInfo.series.title);
						const episodeName = this.cleanName(mediaInfo.title);
						
						const epNum = (''+mediaInfo.season) + 'x' + padLeft(mediaInfo.episode, 2);
						const sortedName = epNum + ' - ' + episodeName + outputExt;
						const seasonFolder = 'Season ' + mediaInfo.season;
						
						let seriesFolder = Path.join(config.tv, seriesName);
						if(probableOptions.length > 2) {
							seriesFolder = Path.join(config.tv, seriesName + ' (' + mediaInfo.series.date.getUTCFullYear() + ')');
						}
						
						return Path.join(seriesFolder, seasonFolder, sortedName);
					});
				});
			} else if(config.movies) {
				result = this.lookup.getMovieOptions(fileInfo.title, fileInfo.year)
				.then((options) => {
					if(!options.length) {
						throw new Error('No Movie matches for ' + fileInfo.title);
					}
					
					const probableOptions = options.filter((o) => o.matchProbability > 0.75)
					.sort((a,b) => b.matchRanking - a.matchRanking);
					
					if(!probableOptions.length) {
						throw new Error('An error occurred filtering Movie results for ' + fileInfo.title);
					}
					
					const mediaInfo = probableOptions[0];
					
					let name = this.cleanName(mediaInfo.title) + outputExt;
					if(probableOptions.length > 2) {
						name = this.cleanName(mediaInfo.title) + ' (' + mediaInfo.date.getUTCFullYear() +')' + outputExt;
					}
					
					return Path.join(config.movies, name);
				});
			} else {
				result = Bluebird.resolve(Path.join(Path.resolve(config.output), fileName + outputExt))
			}
			
			return result.catch((err) => {
				console.error('An error occurred finding info for', fileName + ext);
				console.error(err);
				return Path.join(Path.resolve(config.output), fileName + outputExt);
			});
		});
	}
	
	cleanName(string) {
		string = diacritics(string);
		string = string.replace(/(\S):\s/g, '$1 - ');
		string = string.replace(/\s&\s/g, ' and ');
		string = string.replace(/[/><:"\\|?*]/g, '');
		return string;
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