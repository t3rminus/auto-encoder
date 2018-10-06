'use strict';
const Bluebird = require('bluebird'),
	_ = require('lodash'),
	rp = require('request-promise'),
	Queue = require('better-queue'),
	MDB = require('moviedb'),
	TVMaze = Bluebird.promisifyAll(require('tvmaze-node'));

class NoResultError extends Error {
	constructor(...args) { super(...args); Error.captureStackTrace(this, NoResultError); }
}

class MissingInfoError extends Error {
	constructor(...args) { super(...args); Error.captureStackTrace(this, MissingInfoError); }
}

class MediaLookup {
	constructor(options) {
		if(!(this instanceof MediaLookup)) {
			return new MediaLookup(options);
		}
		
		if(options.mdbApiKey) {
			this.mdb = this.buildMDBProxy(options);
			this.mdbConfigCache = this.mdb.configuration();
		}
		
		this.tvmazeShowCache = {};
		this.tvmazeIdCache = {};
		this.xemCache = {};
		this.posterSize = options.posterSize || 680; // TVDB uses 680x1000
	}
	
	buildMDBProxy(options) {
		const mdb = MDB(options.mdbApiKey);
		
		const requestQueue = new Queue((request, callback) => {
			request.args.push(callback);
			request.target[request.prop].apply(request.target, request.args)
		}, {
			afterProcessDelay: 1000,
			maxRetries: 3,
			retryDelay: 60000
		});
		
		return new Proxy(mdb, {
			get: (target, prop) => {
				if(MediaLookup.isFunction(target[prop])) {
					return function() {
						return Bluebird.fromCallback((cb) => {
							requestQueue.push({
								target: target,
								prop: prop,
								args: Array.prototype.slice.call(arguments)
							}, cb);
						});
					};
				}
				return target[prop];
			}
		});
	}
	
	getTVSeriesOptions(series, year) {
		return TVMaze.searchAsync(series.trim())
		.then((seriesResults) => {
			seriesResults = JSON.parse(seriesResults);
			if(!seriesResults || !seriesResults.length) {
				return [];
			}
			return MediaLookup.rateResults(seriesResults.map(item => MediaLookup.normalizeTVMazeSeries(item)), series, year);
		});
	}
	
	getTVSeries(series, year, force) {
		if(this.tvmazeShowCache[series] && this.tvmazeShowCache[series][year] && !force) {
			return this.tvmazeShowCache[series][year];
		}
		
		if(!this.tvmazeShowCache[series]) {
			this.tvmazeShowCache[series] = {};
		}
		return this.tvmazeShowCache[series][year] = this.getTVSeriesOptions(series, year)
		.then((seriesResults) => {
			if(!seriesResults && !seriesResults.length) {
				throw new NoResultError('A movie with that TVMaze ID was not found');
			}
			
			return MediaLookup.bestResult(seriesResults, series, year);
		})
		.then((series) => {
			return this.getTVSeriesInfo(series.tvMazeId);
		})
	}
	
	getTVSeriesInfo(tvMazeId) {
		return Bluebird.try(() => {
			if(this.tvmazeIdCache[tvMazeId]) {
				return this.tvmazeIdCache[tvMazeId];
			}
			
			return this.tvmazeIdCache[tvMazeId] = TVMaze.showByIdAsync(tvMazeId, false, false)
			.then(series => JSON.parse(series))
			.then(series => MediaLookup.normalizeTVMazeSeries(series))
			.then(series => {
				return TVMaze.showByIdAsync(tvMazeId, 'episodes', 'specials')
				.then(seriesEpisodes => JSON.parse(seriesEpisodes))
				.then(episodes => {
					if(!episodes || !episodes.length) {
						throw new NoResultError('No episodes were found for ' + series.title);
					}
					series.episodes = episodes.map(episode => MediaLookup.normalizeTVMazeEpisode(episode))
					.sort((a, b) => {
						return (((a.season + 1) * 10000) + a.episode) - (((b.season + 1) * 10000) + b.episode);
					});
					
					return series;
				});
			});
		});
	}
	
	getTVSeriesPoster(tvmazeId) {
		return this.getTVSeriesInfo(tvmazeId)
		.then(series => {
			return series.poster || null;
		});
	}
	
	getTVEpisode(series, seasonNumber, episodeNumber, year) {
		return Bluebird.try(() => {
			let seriesPromise;
			if(MediaLookup.isString(series)) {
				seriesPromise = this.getTVSeries(series, year);
			} else if(MediaLookup.isNumber(series)) {
				seriesPromise = this.getTVSeriesInfo(series);
			} else if(series.imdbId) {
				seriesPromise = Promise.resolve(series);
			} else {
				throw new MissingInfoError('Provided series was not valid');
			}
			
			return seriesPromise
			.catch(() => {
				throw new NoResultError(`No episodes were found for ${series}`);
			})
			.then((seriesResult) => {
				const seriesName = seriesResult && seriesResult.title || series;
				if(!Array.isArray(seriesResult.episodes)) {
					throw new NoResultError(`No episodes were found for ${seriesName}`);
				}
				
				const result = seriesResult.episodes.find((episode) => {
					return +episode.season === +seasonNumber && +episode.episode === +episodeNumber;
				});
				
				if(result) {
					return result;
				}
				
				return this.getXEMSeries(seriesResult)
				.catch(() => {
					throw new NoResultError(`Episode ${seasonNumber}x${episodeNumber} was not found for ${seriesName}`);
				})
				.then(data => {
					const mapped = data.find(item => {
						if(!item.scene) return false;
						return +item.scene.season === +seasonNumber &&
							+item.scene.episode === +episodeNumber;
					});
					
					if(mapped) {
						const result = seriesResult.episodes.find((episode) => {
							return +episode.season === +mapped.tvdb.season &&
								+episode.episode === +mapped.tvdb.episode;
						});
						
						if(result) {
							return result;
						}
					}
					
					throw new NoResultError(`Episode ${seasonNumber}x${episodeNumber} was not found for ${seriesName}`);
				});
			});
		});
	}
	
	getMovie(movieTitle, year) {
		return this.getMovieOptions(movieTitle, year)
		.then((results) => {
			if(!results.length) {
				throw new NoResultError('No results for ' + year + ' - ' + movieTitle);
			}
			return MediaLookup.bestResult(results, MediaLookup.clearFileExtension(movieTitle), year);
		})
		.then((theMovie) => {
			return this.getMovieInfo(theMovie.mdbId);
		});
	}
	
	getMovieInfo(mdbId) {
		return Bluebird.try(() => {
			if(!this.mdb) {
				throw new MissingInfoError('MDB API key was not specified');
			}
			if(!mdbId) {
				throw new MissingInfoError('MDB ID was not specified');
			}
			
			return this.mdbConfigCache.then((mdbConfig) => {
				return this.mdb.movieInfo({ id: mdbId })
				.then((movieResult) => {
					if(!movieResult) {
						throw new NoResultError('A movie with that MDB ID was not found');
					}
					
					return MediaLookup.normalizeMDB(movieResult, mdbConfig);
				});
			});
		});
	}
	
	getMovies(movieTitle, year) {
		return Bluebird.try(() => {
			if(!this.mdb) {
				throw new MissingInfoError('MDB API key was not specified');
			}
			if(!movieTitle) {
				throw new MissingInfoError('Movie title was not specified');
			}
			
			const query = { query: MediaLookup.clearFileExtension(movieTitle) };
			if(year) {
				query.year = year;
			}
			
			return this.mdbConfigCache.then((mdbConfig) => {
				return this.mdb.searchMovie(query)
				.then((movieResults) => {
					if(!movieResults.results.length){
						return [];
					}
					return Bluebird.map(movieResults.results, (movieResult) => {
						return MediaLookup.normalizeMDB(movieResult, mdbConfig, 150);
					})
					.then(function(results) {
						return MediaLookup.rateResults(results, movieTitle, year);
					});
				});
			});
		});
	}
	
	getXEMSeries(series, year) {
		return Bluebird.try(() => {
			let seriesPromise;
			if (MediaLookup.isString(series)) {
				seriesPromise = this.getTVSeries(series, year);
			} else if (MediaLookup.isNumber(series)) {
				seriesPromise = this.getTVSeriesInfo(series);
			} else if (series.imdbId) {
				seriesPromise = Promise.resolve(series);
			} else {
				throw new MissingInfoError('Provided series was not valid');
			}
			
			return seriesPromise.then(series => {
				if(!series.tvdbId) {
					throw new MissingInfoError('Provided series does not have a TVDBID');
				}
				
				if(!this.xemCache[series.tvdbId]) {
					this.xemCache[series.tvdbId] = rp(`http://thexem.de/map/all?id=${+series.tvdbId}&origin=tvdb`)
					.then(r => JSON.parse(r));
				}
				
				return this.xemCache[series.tvdbId];
			})
			.then((result) => {
				if(!result.result || result.result !== 'success') {
					throw new MissingInfoError('Provided series doesn\'t exist on theXEM');
				}
				
				return result.data;
			});
		});
	}
	
	static normalizeMDB(info, mdbConfig, posterSize) {
		let thePoster;
		if(mdbConfig && mdbConfig.images && mdbConfig.images.poster_sizes) {
			const bestPosterSize = MediaLookup.bestPoster(mdbConfig.images.poster_sizes, posterSize || this.posterSize || 500);
			thePoster = mdbConfig.images.base_url + bestPosterSize + info.poster_path;
		}
		const result = {
			title: info.name || info.title,
			description: info.overview,
			date: new Date(info.release_date),
			mdbId: info.id,
			poster: thePoster,
			rating: info.vote_average / 2 // Normally out of 10
		};
		
		// If the info has a "status", then it's the full meal deal, not the shortened info object.
		if(info.status) {
			if(info.genres && info.genres.length) {
				result.genres = info.genres.map( genre => genre.name );
			} else {
				result.genres = [];
			}
			result.imdbId = info.imdb_id;
			result.tagline = info.tagline;
			result.runtime = info.runtime;
		}
		return result;
	}
	
	static normalizeTVMazeSeries(info, tvdbConfig, posterSize) {
		let score = info.score;
		info = info.show || info;
		const result = {
			title: info.name,
			date: new Date(info.premiered),
			description: info.summary,
			tvMazeId: info.id,
			rating: info.rating.average / 2, // Normally out of 10
			runtime: info.runtime
		};
		
		if(score) {
			result.searchScore = score;
		}
		
		if(info.genres && info.genres.length) {
			result.genres = info.genres;
		} else {
			result.genres = [];
		}
		
		if(info.externals && info.externals.imdb) {
			result.imdbId = info.externals.imdb;
		}
		
		if(info.externals && info.externals.thetvdb) {
			result.tvdbId = info.externals.thetvdb;
		}
		
		if(info.image && info.image.original) {
			result.poster = info.image.original;
		}
		
		return result;
	}
	
	static normalizeTVMazeEpisode(info) {
		return {
			title: info.name,
			tvMazeId: info.id,
			description: info.summary,
			season: info.season,
			episode: info.number,
			date: new Date(info.airdate)
		};
	}
	
	static clearFileExtension(title) {
		return title.replace(/\.(3g2|3gp|3gpp|asf|avi|divx|f4v|flv|h264|ifo|m2ts|m4v|mkv|mod|mov|mp4|mpeg|mpg|mswmm|mts|mxf|ogv|rm|srt|swf|ts|vep|vob|webm|wlmp|wmv)$/, '');
	}
	
	static compareNames(a, b) {
		return a.toLowerCase().replace(/[^a-z]+/, '') === b.toLowerCase().replace(/[^a-z]+/, '')
	}
	static posterWidth(sz) {
		return sz === 'original' ? 2048 : parseInt(sz.replace(/^w/, ''));
	}
	static bestPoster(sizes, size) {
		let curr = MediaLookup.posterWidth(sizes[0]) || 0, idx = -1;
		for(let i = 0; i < sizes.length; i++) {
			const num = MediaLookup.posterWidth(sizes[i]);
			if(Math.abs(num - size) < Math.abs(num - curr)) {
				curr = num;
				idx = i;
			}
		}
		return sizes[idx] || 'original';
	}
	static resultMax(value) {
		// Magic math to find a nice round value slightly above a known one
		// Used to determine probability, such that there will never be an exact match
		// But a variety of values approaching 1
		const scaleFactors = [500, 100, 50, 10, 5];
		let scale = Math.pow(10, Math.floor(Math.log(value) / Math.log(10))), startScale = scale;
		if(scale > 1000) {
			while(value % scale < scale / 2.1) {
				scale = scale / 10;
			}
		} else {
			let scaleFactor = 0;
			while(value % scale < scale / 2.1 && scaleFactors[scaleFactor] && scaleFactors[scaleFactor] > startScale / 11) {
				scale = scaleFactors[scaleFactor++];
			}
		}
		
		return Math.ceil(value / scale) * scale;
	}
	static rateResults(results, title, year) {
		if(!results || !results.length) {
			return results;
		}
		
		title = title ? title.trim() : '';
		year = year && +year;
		let maxRank = -1;
		results.forEach((result) => {
			let rating = 1;
			let name = result.name || result.title || '';
			if(name === '') {
				return 0; // Yeah these results are just BAD
			}
			name = name.replace(/ ?\([0-9]+\)$/,''); // Get rid of year (if any), we're checking it elsewhere
			if(('' + name).toLowerCase() === ('' + title).toLowerCase()) {
				rating += 6500;
			} else if(MediaLookup.compareNames(name, title)) {
				rating += 4000;
			}
			if(result.aliases && result.aliases.find) {
				if(result.aliases.find((item) => ('' + item).toLowerCase() === ('' + title).toLowerCase())) {
					rating += 4000;
				} else if(result.aliases.find((item) => MediaLookup.compareNames(item, title))) {
					rating += 1500;
				}
			}
			if(result.popularity) {
				rating += (result.popularity * 1000);
			}
			if(result.searchScore) {
				rating += (result.searchScore * 800);
			}
			if(result.date) {
				if(year) {
					rating += (new Date(result.date)).getFullYear() === +year ? 2000 : 0;
				}
				rating += MediaLookup.recentRating(result.date) * 4;
			}
			if(rating > maxRank) {
				maxRank = rating;
			}
			
			result.matchRanking = rating;
		});
		maxRank = MediaLookup.resultMax(maxRank);
		results.forEach((result) => {
			result.matchProbability = +((result.matchRanking / maxRank).toFixed(4));
		});
		
		return results;
	}
	static bestResult(results, title, year) {
		if(!results || !results.length) {
			return [];
		}
		
		results = MediaLookup.rateResults(results, title, year);
		// Actual search results seem pretty good.
		// results.sort((a,b) => a.matchProbability - b.matchProbability).reverse();
		
		return results[0];
	}
	static recentRating(date){
		let time = new Date(date);
		time = ((1577923200 + (time.getTime() / 1000)) / 86400) | 0;
		return time / 60 | 0;
	}
	
	static isFunction(value) {
		const type = typeof value;
		const tag = Object.prototype.toString.call(value);
		
		return value != null && (type === 'object' || type === 'function') &&
			(tag === '[object Function]' || tag === '[object GeneratorFunction]' ||
				tag === '[object AsyncFunction]' || tag === '[object Proxy]');
	}
	
	static isString(value) {
		return (typeof value === 'string') ||
			(!Array.isArray(value) && value != null && typeof value === 'object' &&
				Object.prototype.toString.call(value) === '[object String]');
	}
	
	static isNumber(value) {
		return (typeof value === 'number') ||
			(value != null && typeof value === 'object' &&
				Object.prototype.toString.call(value) === '[object Number]');
	}
}

module.exports = MediaLookup;
MediaLookup.NoResultError = NoResultError;
MediaLookup.MissingInfoError = MissingInfoError;


