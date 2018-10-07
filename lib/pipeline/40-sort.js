const PipelineStep = require('../pipeline-step');
const fs = require('fs-extra');
const Path = require('path');

class Sorter extends PipelineStep {
	constructor(config) {
		super(config);
		// Config values
		this.delete = config.deleteAfterEncoding;
	}
	
	async process(items) {
		for(const item of items) {
			if(item.resultName && item.resultName !== item.path && this.delete) {
				await fs.move(item.path, item.resultName, { overwrite: true });
				item.path = item.resultName;
				this.log(`Sorted ${Path.basename(item.resultName)}`);
			} else if(item.resultName && item.resultName !== item.path) {
				await fs.copy(item.path, item.resultName, { overwrite: true });
				item.path = item.resultName;
				this.log(`Sorted ${Path.basename(item.resultName)}`);
			} else {
				this.log(`Not sorting ${Path.basename(item.path)}`);
			}
		}
		
		return items;
	}
}

module.exports = Sorter;