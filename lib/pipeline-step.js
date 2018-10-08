
class PipelineStep {
	constructor(config) {
		this.verbose = config.verbose !== undefined ? config.verbose : true;
		this.silly = !!config.silly;
	}
	
	log(...args) {
		this.verbose && console.log(...args);
	}
	
	logSilly(...args) {
		this.silly && console.info(...args);
	}
	
	process(items) {
		console.log(`Unimplemented pipleline step. Items passed:${items.map(i => i.path).join('\n\t- ')}`);
	}
}

module.exports = PipelineStep;