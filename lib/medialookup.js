'use strict';
const util = require('util'),
	Bluebird = require('bluebird'),
	_ = require('lodash'),
	MDB = require('moviedb'),
	TVMaze = Bluebird.promisifyAll(require('tvmaze-node'));

const NoResultError = function NoResultError(message) {
	Error.captureStackTrace(this, this.constructor);
	this.name = this.constructor.name;
	this.message = message;
};
const MissingInfoError = function MissingInfoError(message) {
	Error.captureStackTrace(this, this.constructor);
	this.name = this.constructor.name;
	this.message = message;
};

util.inherits(NoResultError, Error);
util.inherits(MissingInfoError, Error);

const compareNames = function(a, b) {
		return a.toLowerCase().replace(/[^a-z]+/, '') == b.toLowerCase().replace(/[^a-z]+/, '')
	},
	posterWidth = function(sz) {
		return sz === 'original' ? 2048 : parseInt(sz.replace(/^w/, ''));
	},
	bestPoster = function bestPoster(sizes, size) {
		let curr = posterWidth(sizes[0]) || 0, idx = -1;
		for(let i = 0; i < sizes.length; i++) {
			const num = posterWidth(sizes[i]);
			if(Math.abs(num - size) < Math.abs(num - curr)) {
				curr = num;
				idx = i;
			}
		}
		return sizes[idx] || 'original';
	},
	bestResult = function bestResult(results, title, year) {
		if(!results || !results.length) {
			return [];
		}
		title = title ? title.trim() : '';
		year = year && +year;
		results = _.sortBy(results, function(result) {
			let rating = 1;
			let name = result.name || result.title || '';
			if(name === '') {
				return 0; // Yeah these results are just BAD
			}
			name = name.replace(/ ?\([0-9]+\)$/,''); // Get rid of year (if any), we're checking it elsewhere
			if(('' + name).toLowerCase() === ('' + title).toLowerCase()) {
				rating += 6500;
			} else if(compareNames(name, title)) {
				rating += 4000;
			}
			if(_.find(result.aliases, function(item){ return ('' + item).toLowerCase() === ('' + title).toLowerCase(); })) {
				rating += 4000;
			} else if(_.find(result.aliases, function(item){ return compareNames(item, title); })) {
				rating += 1500;
			}
			if(result.popularity) {
				rating += (result.popularity * 800);
			}
			if(result.searchScore) {
				rating += (result.searchScore * 400);
			}
			if(result.date) {
				if(year) {
					rating += (new Date(result.date)).getFullYear() === +year ? 4000 : 0;
				}
				rating += recentRating(result.date) * 7;
			}
			return rating;
		});
		results = results.reverse();
		
		return results[0];
	},
	recentRating = function(date){
		let time = new Date(date);
		time = ((1577923200 + (time.getTime() / 1000)) / 86400) | 0;
		return time / 60 | 0;
	};

const MediaLookup = function(options) {
	if(!(this instanceof MediaLookup)) {
		return new MediaLookup(options);
	}
	
	if(options.mdbApiKey) {
		this.mdb = Bluebird.promisifyAll(MDB(options.mdbApiKey));
		this.mdbConfigCache = this.mdb.configurationAsync();
	}
	
	this.mdbShowCache = {};
	this.tvmazeShowCache = {};
	this.tvmazeIdCache = {};
	this.tvmazePosterCache = {};
	this.posterSize = options.posterSize || 680; // TVDB uses 680x1000
};

module.exports = MediaLookup;
module.exports.NoResultError = NoResultError;
module.exports.MissingInfoError = MissingInfoError;

MediaLookup.clearFileExtension = function MediaLookup_clearFileExtension(title) {
	return title.replace(/\.(3g2|3gp|3gpp|asf|avi|divx|f4v|flv|h264|ifo|m2ts|m4v|mkv|mod|mov|mp4|mpeg|mpg|mswmm|mts|mxf|ogv|rm|srt|swf|ts|vep|vob|webm|wlmp|wmv)$/, '');
};

MediaLookup.prototype.getTVSeriesOptions = function MediaLookup_getTVSeries(series) {
	return TVMaze.searchAsync(series.trim())
		.then((seriesResults) => {
			seriesResults = JSON.parse(seriesResults);
			if(!seriesResults || !seriesResults.length) {
				return [];
			}
			return seriesResults.map(item => this.normalizeTVMazeSeries(item));
		});
};

MediaLookup.prototype.getTVSeries = function MediaLookup_getTVSeries(series, year) {
	if(this.tvmazeShowCache[series] && this.tvmazeShowCache[series][year]) {
		return this.tvmazeShowCache[series][year];
	}
	
	if(!this.tvmazeShowCache[series]) {
		this.tvmazeShowCache[series] = {};
	}
	return this.tvmazeShowCache[series][year] = this.getTVSeriesOptions(series)
		.then((seriesResults) => {
			if(!seriesResults && !seriesResults.length) {
				throw new NoResultError('A movie with that TVMaze ID was not found');
			}
			
			return bestResult(seriesResults, series, year);
		})
		.then((series) => {
			return this.getTVSeriesInfo(series.tvMazeId);
		})
};

MediaLookup.prototype.getTVSeriesInfo = function MediaLookup_getTVSeriesInfo(tvMazeId) {
	return Bluebird.try(() => {
		if(this.tvmazeIdCache[tvMazeId]) {
			return this.tvmazeIdCache[tvMazeId];
		}
		
		return this.tvmazeIdCache[tvMazeId] = TVMaze.showByIdAsync(tvMazeId, false, false)
			.then(series => JSON.parse(series))
			.then(series => this.normalizeTVMazeSeries(series))
			.then(series => {
				return TVMaze.showByIdAsync(tvMazeId, 'episodes', 'specials')
					.then(seriesEpisodes => JSON.parse(seriesEpisodes))
					.then(episodes => {
						if(!episodes || !episodes.length) {
							throw new NoResultError('No episodes were found for ' + series.title);
						}
						series.episodes = episodes.map(episode => this.normalizeTVMazeEpisode(episode))
							.sort((a, b) => {
								return (((a.season + 1) * 10000) + a.episode) - (((b.season + 1) * 10000) + b.episode);
							});
						
						return series;
					});
			});
	});
};

MediaLookup.prototype.getTvSeriesPoster = function MediaLookup_getTVSeriesPoster(tvmazeId) {
	return this.getTVSeriesInfo(tvmazeId)
		.then(series => {
			return series.poster || null;
		});
};

MediaLookup.prototype.getTVEpisode = function MediaLookup_getTVEpisode(series, seasonNumber, episodeNumber, year) {
	return Bluebird.try(() => {
		let seriesPromise;
		if(_.isString(series)) {
			seriesPromise = this.getTVSeries(series, year);
		} else if(_.isNumber(series)) {
			seriesPromise = this.getTVSeriesInfo(series);
		} else if(series.imdbId) {
			seriesPromise = Promise.resolve(series);
		} else {
			throw new MissingInfoError('Provided series was not valid');
		}
		
		return seriesPromise.then((seriesResult) => {
			if(!Array.isArray(seriesResult.episodes)) {
				throw new NoResultError('No episodes were found for ' + seriesResult && seriesResult.title || series);
			}
			
			const result = seriesResult.episodes.find((episode) => {
				return +episode.season === +seasonNumber && +episode.episode === +episodeNumber;
			});
			
			if(!result) {
				throw new NoResultError('Episode ' + seasonNumber + 'x' + episodeNumber + ' was not found for series ' + seriesResult && seriesResult.title || series);
			}
			
			return result;
		})
		.catch(() => {
			throw new NoResultError('No episodes were found for ' + series);
		});
	});
};

MediaLookup.prototype.getMovie = function MediaLookup_getMovie(movieTitle, year) {
	return this.getMovieOptions(movieTitle, year)
		.then((results) => {
			if(!results.length) {
				throw new NoResultError('No results for ' + year + ' - ' + movieTitle);
			}
			return bestResult(results, MediaLookup.clearFileExtension(movieTitle), year);
		})
		.then((theMovie) => {
			return this.getMovieInfo(theMovie.mdbId);
		});
};
MediaLookup.prototype.getMovieInfo = function MediaLookup_getMovieInfo(mdbId) {
	return Bluebird.try(() => {
		if(!this.mdb) {
			throw new MissingInfoError('MDB API key was not specified');
		}
		if(!mdbId) {
			throw new MissingInfoError('MDB ID was not specified');
		}
		
		return this.mdbConfigCache.then((mdbConfig) => {
			return this.mdb.movieInfoAsync({ id: mdbId })
			.then((movieResult) => {
				if(!movieResult) {
					throw new NoResultError('A movie with that MDB ID was not found');
				}
				
				return this.normalizeMDB(movieResult, mdbConfig);
			});
		});
	});
};
MediaLookup.prototype.getMovieOptions = function MediaLookup_getMovies(movieTitle, year) {
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
			return this.mdb.searchMovieAsync(query)
				.then((movieResults) => {
					if(!movieResults.results.length){
						return [];
					}
					return Bluebird.map(movieResults.results, (movieResult) => {
						return this.normalizeMDB(movieResult, mdbConfig, 150);
					});
				});
		});
	});
};
MediaLookup.prototype.normalizeMDB = function MediaLookup_normalizeMDB(info, mdbConfig, posterSize) {
	let thePoster;
	if(mdbConfig && mdbConfig.images && mdbConfig.images.poster_sizes) {
		const bestPosterSize = bestPoster(mdbConfig.images.poster_sizes, posterSize || this.posterSize || 500);
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
};
MediaLookup.prototype.normalizeTVMazeSeries = function MediaLookup_normalizeTVDBSeries(info, tvdbConfig, posterSize) {
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
	
	if(info.image && info.image.original) {
		result.poster = info.image.original;
	}
	
	return result;
};
MediaLookup.prototype.normalizeTVMazeEpisode = function MediaLookup_normalizeTVDBEpisode(info) {
	return {
		title: info.name,
		tvMazeId: info.id,
		description: info.summary,
		season: info.season,
		episode: info.number,
		date: new Date(info.airdate)
	};
};