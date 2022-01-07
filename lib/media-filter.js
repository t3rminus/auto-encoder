const diacritics = require('./diacritics');
const Misc = require('./misc');
const Path = require('path');
const MediaLookup = require('./medialookup');
const ptn = require('parse-torrent-name');

class Filter {
	constructor(config) {
		// Log Stuff
		this.verbose = config.verbose;
		this.silly = config.silly;

		// Directories
		this.watch = config.watch;
		this.output = config.output;
		this.movies = config.movies;
		this.tv = config.tv;

		// File extension
		this.outputFormat = config.outputFormat || '.mp4';
		if(!/^\./.test(this.outputFormat)) {
			this.outputFormat = '.' + this.outputFormat;
		}

		// Lookup service & cache
		this.lookup = new MediaLookup({ mdbApiKey: config.mdbAPIKey || process.env.MDB_API });
    this.sortCache = [];

    // Other config
    this.overwrite = config.overwrite;
    this.textReplacements = config.textReplacements;
	}

	async checkPath(path) {
		const ext = Path.extname(path).replace(/^\./,'');
		const fileName = Path.basename(path, ext);

		if(!Misc.isMedia(path)) {
			this.logSilly(`Not a media file:\n\t${fileName}`);
			return false;
		}

		if(/(^sample-|-sample$)/.test(fileName)) {
			this.logSilly(`Ignoring encode for file -- likely sample:\n\t${fileName}`);
			return false;
		}

		const resultName = await this.getOutputFile(path);
		if(await Misc.fileExists(resultName) && !this.overwrite) {
			this.logSilly(`Ignoring encode for file -- already exists:\n\t${fileName}`);
			return false;
		}

		return true;
	}

	async getOutputFile(path) {
		const ext = Path.extname(path);
		const fileName = Path.basename(path, ext);

		const cached = this.sortCache.find(c => c.fileName === fileName);
		if(cached) {
			return cached.output;
		}

		const output = await this.lookupOutputFile(path);

		if(this.sortCache.length > 300) {
			this.sortCache = this.sortCache.slice(0, 300);
		}

		this.sortCache.unshift({ fileName: fileName, output: output });
		return output;
	}

	async lookupOutputFile(path) {
		const ext = Path.extname(path);
		const fileName = Path.basename(path, ext);
		const fileInfo = ptn(fileName);

    if(!fileInfo.year) {
      const yearFallback = /[0-9]{4}$/.exec(fileInfo.title);
      if(yearFallback && yearFallback[0]) {
        fileInfo.year = yearFallback[0];
      }
    }

		let outputExt = (this.outputFormat || 'mp4');
		if(!/^\./.test(outputExt)) {
			outputExt = '.' + outputExt;
		}

		const fallbackPath = Path.join(Path.resolve(this.output), fileName + outputExt);

		try {
			if(fileInfo.season && fileInfo.episode && this.tv) {
				// Get all possible matching TV Series
				const seriesOptions = await this.lookup.getTVSeriesOptions(this.doReplacements(fileInfo.title), fileInfo.year);

				if(!seriesOptions.length) {
					console.error(`No TV series matches for ${fileInfo.title}`);
					return fallbackPath;
				}

				// Sort according to most-likely match
				const probableOptions = seriesOptions.filter((o) => o.matchProbability > 0.75)
				  .sort((a,b) => a.matchRanking - b.matchRanking);

				if(!probableOptions.length) {
					console.error(`An error occurred filtering TV series results for ${fileInfo.title}`);
					return fallbackPath;
				}

				// This is the series we want. Remove it from the list
				const series = probableOptions.shift();

				// Find the episode
				let episode;
				try {
					episode = await this.lookup.getTVEpisode(series.tvMazeId, fileInfo.season, fileInfo.episode);
				} catch(err) {
					if(!(err instanceof MediaLookup.NoResultError)) {
						console.error(err);
						return Path.join(Path.resolve(this.output), fileName + outputExt);
					}

					// Maybe the "Season" is by year. Try that?
					try {
						episode = await this.lookup.getTVEpisode(series.tvMazeId, fileInfo.year, fileInfo.episode);
					} catch(err2) {
						if(!(err2 instanceof MediaLookup.NoResultError)) {
							console.error(err2);
							return Path.join(Path.resolve(this.output), fileName + outputExt);
						}
						episode = null;
					}
				}

				if(!episode) {
					console.error(`No TV episode matches for ${fileName}`);
					return fallbackPath;
				}

				// Collect some info
				const seriesName = Filter.cleanName(series.title);
				const episodeName = Filter.cleanName(episode.title);

				const epNum = (''+episode.season) + 'x' + Misc.padLeft(episode.episode, 2);
				const sortedName = epNum + ' - ' + episodeName + outputExt;
				const seasonFolder = 'Season ' + episode.season;

				let seriesFolder = Path.join(this.tv, seriesName);

				// Is there another series with the same name? If so, append the year
				if(probableOptions.find((s) => Filter.cleanName(s.title) === seriesName)) {
					seriesFolder = Path.join(this.tv, seriesName + ' (' + series.date.getUTCFullYear() + ')');
				}

				return Path.join(seriesFolder, seasonFolder, sortedName);
			} else if(this.movies) {

				// Get all possible movies
				const movieOptions = await this.lookup.getMovies(this.doReplacements(fileInfo.title), fileInfo.year);

				if(!movieOptions.length) {
					console.error(`No Movie matches for ${fileInfo.title}`);
					return fallbackPath;
				}

				// Sort according to most-likely match
				const probableOptions = movieOptions.filter((o) => o.matchProbability > 0.75)
				.sort((a,b) => b.matchRanking - a.matchRanking);

				if(!probableOptions.length) {
					console.error(`An error occurred filtering Movie results for  ${fileInfo.title}`);
					return fallbackPath;
				}

				// This is our movie
				const mediaInfo = probableOptions.shift();

				// Get the clean name
				let name = Filter.cleanName(mediaInfo.title) + outputExt;
				if(probableOptions.length) {
					name = Filter.cleanName(mediaInfo.title) + ' (' + mediaInfo.date.getUTCFullYear() +')' + outputExt;
				}

				return Path.join(this.movies, name);
			} else {
				return Path.join(Path.resolve(this.output), fileName + outputExt)
			}
		} catch(err) {
			console.error(err.message);
			return fallbackPath;
		}
	}

	logSilly(...args) {
		this.silly && console.info(...args);
	}

  doReplacements(str) {
    if(this.textReplacements && Array.isArray(this.textReplacements) && this.textReplacements.length) {
      return this.textReplacements.reduce((str, rep) => rep.find.regexp ? str.replace(new RegExp(rep.find.regexp, rep.find.flags), rep.replace) : str.replace(rep.find, rep.replace), str);
    }
    return str;
  }

	static cleanName(string) {
		string = diacritics(string);
		string = string.replace(/(\S):\s/g, '$1 - ');
		string = string.replace(/\s&\s/g, ' and ');
		string = string.replace(/[/><:"\\|?*]/g, '');
    string = string.replace(/\.\.\./g, '…');
		string = string.replace(/(^[^a-z0-9]+|[^a-z0-9)]+$)/i,'');
		return string;
	}
}

module.exports = Filter;