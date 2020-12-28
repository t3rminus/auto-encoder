const Queue = require('better-queue');
const Datastore = require('nedb-promise');
const Path = require('path');
const fs = require('fs-extra');
const os = require('os');

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
	deleteAfterExtracting: false,
	deleteAfterEncoding: true,
	verbose: true
};

class Application {
	constructor() {
		this.queue = new Queue(this.process.bind(this), {
			// Retry at most 2 times
			maxRetries: 2,
			// This will ignore repeated queues of the same file
			merge: (oldTask, newTask, cb) => cb(null, oldTask)
		});

		if(process.env.AE_CONFIG_DIR) {
			this.configDir = Path.resolve(process.env.AE_CONFIG_DIR);
			this.configFile = Path.resolve(Path.join(process.env.AE_CONFIG_DIR, 'config.json'));
		} else if(process.env.DOCKER) {
			this.configDir = Path.resolve('/config');
			this.configFile = Path.resolve('/config/config.json');
		} else {
			this.configDir = Path.resolve('.');
			this.configFile = Path.resolve('config.json');
		}

		this.fileDb = new Datastore({ filename: Path.join(this.configDir, 'files.db'), autoload: true });
		this.fileDb.ensureIndex({ fieldName: 'path', unique: true }, (err) => {
			if(err) { console.error(err); process.exit(1); }
		});
	}

	async run() {
		this.config = await this.getConfig();
		this.pipeline = await this.generatePipeline(this.config);

		const sources = await this.getSources(this.config);

		for(const source of sources) {
			source.on('file', async (path) => {
				try {
					// Make sure it exists
					await fs.stat(path); // Make sure the file exists (throws if it doesn't)
					// Try to insert it. If it fails (unique key), it's already been processed
					await this.fileDb.insert({ path });
					if(this.config.crazy) {
						console.info(`Queueing ${Path.basename(path)}`);
					}
					this.queue.push({ id: path, path }, async (err) => {
						// An error occurred during processing. Remove the key.
						if(err) {
							await this.fileDb.remove({ path });
							console.error('An error occurred processing a file');
							console.error(err);
						}
					});
				} catch(err) { /* ignore. Assume already processed */ }
			});

			try {
				await source.init();
			} catch(err) {
				console.error('An error occurred initializing a source:');
				console.error(err);
			}
		}
	}

	process(task, cb) {
		if(!this.pipeline) {
			return cb(new Error('Pipeline not ready!'));
		}
		if(this.config.verbose) {
			console.info(`Starting ${Path.basename(task.path)}`);
		}
		if(this.config.silly) {
			console.info('Queue stats:');
			console.info(JSON.stringify(this.queue.getStats(),null,4));
		}
		this.pipeline([{ path: task.path }]).then((r) => cb(null,r), cb);
	}

	async getConfig() {
		// Load config file
		let configStr;
		try {
			configStr = await fs.readFile(this.configFile, 'utf8');
		} catch(err) { /* ignore */ }
		if(!configStr) {
			return Application.writeDefaultConfig();
		}

		// Parse config file
		let config;
		try {
			config = Object.assign({}, JSON.parse(configStr));
		} catch(err) {
			console.error('Config data was not a parseable JSON object.\nExiting for safety.');
			process.exit(1);
		}

		// Some defaults
		config.configDir = this.configDir;
		config.verbose = config.verbose !== false;
		config.crazy = false;

		// If we're running in docker, or have environment variables
		// ignore these configs...
		if(process.env.AE_EXTRACT_DIR) {
			config.extract = process.env.AE_EXTRACT_DIR;
		} else if(process.env.DOCKER) {
			config.extract = '/extract';
		}
		if(process.env.AE_OUTPUT_DIR) {
			config.output = process.env.AE_OUTPUT_DIR;
		} else if(process.env.DOCKER) {
			config.output = '/output';
		}
		if(process.env.AE_MOVIES_DIR) {
			config.movies = process.env.AE_MOVIES_DIR;
		} else if(process.env.DOCKER) {
			config.movies = '/movies';
		}
		if(process.env.AE_TV_DIR) {
			config.tv = process.env.AE_TV_DIR;
		} else if(process.env.DOCKER) {
			config.tv = '/tv';
		}

		// Make sure all the directories exist
		// Need these ones, minimum
		try {
			if(config.output) {
				config.output = Path.resolve(config.output);
				await fs.ensureDir(config.output);
			} else {
				console.error('Missing output directory (config.output/AE_OUTPUT_DIR)');
				process.exit(1);
			}

			// These are optional
			config.extract = Path.resolve(config.extract || Path.join(os.tmpdir(), 'auto-encoder'));
			await fs.ensureDir(config.extract);

			if(config.movies) {
				config.movies = Path.resolve(config.movies);
				await fs.ensureDir(config.movies);
			}
			if(config.tv) {
				config.tv = Path.resolve(config.tv);
				await fs.ensureDir(config.tv);
			}
		} catch(err) {
			console.error(`One or more directories couldn't be made/accessed:\n\n${err.message}`);
			process.exit(1);
		}

		return config;
	}

	static async writeDefaultConfig() {
		const sampleFile = Path.resolve(Path.join(process.env.CONFIG_DIR, 'config.sample.json'));
		await fs.writeFile(sampleFile, JSON.stringify(defaultConfig, null, 4));
		console.error('Missing or invalid configuration.\nA sample configuration has been written to config.sample.js.\nExiting for safety.');
		process.exit(1);
	}

	async generatePipeline(config) {
		let pipeline = (await fs.readdir(Path.join(__dirname, 'lib', 'pipeline')))
			.filter(f => /\.js$/.test(f));

		pipeline.sort((a,b) => parseInt(a, 10) - parseInt(b,10));

		pipeline = pipeline.map((file) => {
				const source = require(Path.join(__dirname, 'lib', 'pipeline', file));
				return new source(config);
			});

		console.log(`Generated pipeline:\r\n\t-${pipeline.map(p => p.constructor.name).join("\r\n\t-")}`);

		return async (items) => {
			for(const step of pipeline) {
				if(this.config.silly) {
					console.info(`Pipeline step ${step.constructor.name}`);
					console.info(`Items to process:\r\n${JSON.stringify(items,null,4)}`);
				}
				if(!items.length) {
					if(this.config.silly) {
						console.log('No items remaining in pipeline. Aborting.');
					}
					break;
				}
				items = await step.process(items);
			}
			return items;
		};
	}

	async getSources(config) {
		return (await fs.readdir(Path.join(__dirname, 'lib', 'sources')))
			.filter(f => /\.js$/.test(f))
			.map((file) => {
				const source = require(Path.join(__dirname, 'lib', 'sources', file));
				return new source(config);
			});
	}
}

(async () => {
	try {
		await new Application().run();
	} catch(err) {
		console.error(`An application error has occurred.`);
		console.error(err);
		process.exit(1);
	}
})();