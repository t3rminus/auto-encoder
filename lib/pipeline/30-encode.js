const PipelineStep = require('../pipeline-step');
const Util = require('util');
const Misc = require('../misc');
const hbjs = require('handbrake-js');
const Path = require('path');
const fs = require('fs-extra');

class Encoder extends PipelineStep {
	constructor(config) {
		super(config);
		// Config Values
		this.preferredLanguage = config.preferredLanguage;
		this.minDuration = config.minDuration;
		this.encodingSettings = config.encodingSettings;
		this.sdEncodingSettings = config.sdEncodingSettings;
    this.surroundEncodingSettings = config.surroundEncodingSettings;
    this.tvEncodingSettings = config.tvEncodingSettings;
    this.movieEncodingSettings = config.movieEncodingSettings;

		// Directories
    this.output = config.output;
    this.movies = config.movies;
    this.tv = config.tv;

		// File extension
		this.outputFormat = config.outputFormat || '.mp4';
		if(!/^\./.test(this.outputFormat)) {
			this.outputFormat = '.' + this.outputFormat;
		}
	}

	async process(items) {
    const finalItems = [];
		for(const item of items) {
			const outFile = await this.encode(item.path, this.kind(item.resultName));
			if(outFile) {
        finalItems.push({ ...item, path: outFile });
				await fs.unlink(item.path);
			}
		}

		return finalItems;
	}

	async encode(path, kind) {
		const filename = Path.basename(path, Path.extname(path));

		// Get media info (a/v tracks, etc.)
		let mediaInfo;
		try {
			mediaInfo = await Misc.mediaInfo(path);
		} catch(err) {
			console.error(err);
		}

		if(!mediaInfo) {
			console.error(`Deleting file (no media info) ${path}`);
			await fs.unlink(path).catch(() => { /* ignore errors */ });
			return;
		}

		if(this.minDuration && (mediaInfo.general.Duration * 1000) < this.minDuration) {
			this.log(`Deleting Sample (too short)\n\t${filename}\n`);
			await fs.unlink(path).catch(() => { /* ignore errors */ });
			return;
		}

		// Prepare encoding settings
		let out = Path.join(this.output, filename + (this.outputFormat || '.mp4'));
		const audioTrack = Encoder.bestAudio(mediaInfo.audio);
		const videoTrack = Encoder.bestVideo(mediaInfo.video);
		const settings = Object.assign({}, this.encodingSettings || {}, { input: path, output: out });

		if(videoTrack) {
			if(videoTrack.track.Height < 720) {
				Object.assign(settings, this.sdEncodingSettings || {});
			}
		} else {
			this.log(`Deleting file (no video tracks)\n\t${filename}\n`);
			await fs.unlink(path).catch(() => { /* ignore errors */ });
			return;
		}

		if(audioTrack) {
			if(audioTrack.track.Channels > 2) {
				Object.assign(settings, this.surroundEncodingSettings || {});
			}
			settings.audio = settings.audio.replace(/%t/g, audioTrack.i + 1);
		} else {
			const audioSettings = ['audio-lang-list','all-audio','first-audio','audio','aencoder',
								   'audio-copy-mask','audio-fallback','ab','aq','ac','mixdown','normalize-mix',
								   'arate','drc','gain','adither','aname'];
			audioSettings.forEach((setting) => { delete settings[setting]; });
    }

    if(kind === 'movie') {
      Object.assign(settings, this.movieEncodingSettings || {});
    }

    if(kind === 'tv') {
      Object.assign(settings, this.tvEncodingSettings || {});
    }

		if(settings.format) {
			delete settings.format;
    }

		// Start encoding
		const dotProgress = [0,20,40,60,80];
		this.logSilly(`Starting encode for ${filename}`);
		await new Promise((y,n) => {
			hbjs.spawn(settings)
				.on('error', n)
				.on('progress', (progress) => {
					if(progress.percentComplete > dotProgress[0]) {
						const curPercent = dotProgress.shift();
						this.log(`Encoding ${filename}: ${curPercent}%`);
					}
				})
				.on('end', y);
		});
		this.log(`Encoding ${filename}: Done.`);
		return out;
  }

  kind(path) {
    const finalPath = `${path}`;
    if(finalPath.indexOf(this.tv) === 0) {
      return 'tv';
    } else if(finalPath.indexOf(this.movies) === 0) {
      return 'movie';
    }
  }

	static bestAudio(trax, lang) {
		if(!trax || !trax.length) {
			return false;
		}

		let bestTrac = trax[0], trackNum = 0;

		for(let i = 0; i < trax.length; i++) {
			const trac = trax[i];
			if(trac.Language && trac.Language === lang && trac.Default && !bestTrac.Default) {
				bestTrac = trac;
				trackNum = i;
			} else if(trac.Language && trac.Language === lang && !bestTrac.Default && trac.Channels > bestTrac.Channels) {
				bestTrac = trac;
				trackNum = i;
			} else if(trac.Language === lang && bestTrac.Language !== trac.Language) {
				bestTrac = trac;
				trackNum = i;
			} else if(trac.Channels > bestTrac.Channels && bestTrac.Language !== trac.Language) {
				bestTrac = trac;
				trackNum = i;
			}
		}
		return { i: trackNum, track: bestTrac };
	}

	static bestVideo(trax) {
		if(!trax || !trax.length) {
			return false;
		}
		let bestTrac = trax[0], trackNum = 0;
		for(let i = 0; i < trax.length; i++) {
			const trac = trax[i];
			if(trac.Width * trac.Height > bestTrac.Width * bestTrac.Height) {
				bestTrac = trac;
				trackNum = i;
			}
		}
		return { i: trackNum, track: bestTrac };
  }
}

module.exports = Encoder;