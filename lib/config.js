import { parse, stringify } from 'yaml'
import fs from 'fs/promises';
import path from 'path';

const CONFIG_FILE = 'config.yaml';
const CONFIG_DIR = process.env.AE_CONFIG_DIR || (process.env.DOCKER ? '/config' : '.');

const AAC = process.platform === 'darwin' ? 'ca_aac' : 'av_aac';
const DEFAULT_CONFIG = {
	encodingSettings: {
		quality: 22,
		encoder: 'x264',
		audio: '%t',
		aencoder: AAC,
		mixdown: 'stereo',
		ab: '192'
	},
	preferredLanguage: 'eng',
	minDuration: 120000,
	deleteAfterExtracting: false,
	deleteAfterEncoding: true,
	verbose: true
};

export default async function loadConfig() {
  const configPath = path.resolve(CONFIG_DIR);

  // Load config file
  let configStr;
  try {
    configStr = await fs.readFile(path.join(configPath, CONFIG_FILE), 'utf8');
  } catch(err) {
    if(err.code === 'ENOENT') {
      // Config file does not exist. Write the default/example file and exit.
      const sampleFile = path.resolve(path.join(configPath, `sample.${CONFIG_FILE}`));
      await fs.writeFile(sampleFile, stringify(DEFAULT_CONFIG));
      console.error(`Missing or invalid configuration.\nA sample configuration has been written to sample.${CONFIG_FILE}.\nExiting for safety.`);
      process.exit(1);
    } else {
      throw err;
    }
  }

  // Parse config file
  let config;
  try {
    config = Object.assign({}, parse(configStr));
  } catch(err) {
    console.error('Config data was not a parseable JSON object.\nExiting for safety.');
    process.exit(1);
  }

  // Some defaults
  config.configDir = configPath;
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