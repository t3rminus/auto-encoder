
class PipelineStep {
	constructor(config) {
		this.verbose = config.verbose !== undefined ? config.verbose : true;
	}
	
	log(...args) {
		this.verbose && console.log(...args);
	}
	
	process(items) {
		console.log(`Unimplemented pipleline step. Items passed:${items.map(i => i.path).join('\n\t- ')}`);
	}
}

module.exports = PipelineStep;