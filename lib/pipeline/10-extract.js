const PipelineStep = require('../pipeline-step');
const Filter = require('../media-filter');
const Path = require('path');
const Misc = require('../misc');
const fs = require('fs-extra');
const Unrar = require('unrar');
const Unzip = require('unzipper');

class Extractor extends PipelineStep {
	constructor(config) {
		super(config);
		this.watch = config.watch;
		this.out = config.extract;
		this.delete = config.deleteAfterExtracting;

		this.filter = new Filter(config);
	}
	
	async process(items) {
		this.logSilly(`Given ${items.length} item(s).`);
		const toExtract = items.filter(({ path }) => {
			const ext = Path.extname(path).replace(/^\./,'');
			return Misc.isMedia(path)
				|| ext === 'zip'
				|| (ext === 'rar' && (!/part[0-9]+\.rar/.test(path)))
				|| /part0*1\.rar/.test(path);
		});
		
		let results = [];
		this.logSilly(`${toExtract.length} items were extractable`);
		for(let item of toExtract) {
			const ext = Path.extname(item.path).replace(/^\./,'');
			if(ext === 'rar' && (!/part[0-9]+\.rar/.test(item.path)) || /part0*1\.rar/.test(item.path)) {
				this.logSilly(`Handling RAR ${item.path}`);
				results = results.concat(await this.handleRar(item));
			} else if(ext === 'zip') {
				this.logSilly(`Handling ZIP ${item.path}`);
				results = results.concat(await this.handleZip(item));
			} else {
				this.logSilly(`Bare file ${item.path}`);
				results = results.concat(await this.handleFile(item));
			}
		}
		
		return results;
	}
	
	async handleRar(item) {
		const arch = new Unrar(item.path);
		let files = await new Promise((y,n) => arch.list((err,files) => err ? n(err) : y(files)));
		
		files = files.filter((file) => {
			return file.type === 'File' && Misc.isMedia(file.name);
		});
		this.logSilly(`RAR files:\r\n${files.map(f => f.name).join('\r\n')}`);
		const results = [];
		for(const file of files) {
			const out = Path.join(this.out, Path.basename(file.name));
			if(await this.filter.checkPath(out)) {
				this.log(`Extracting ${Path.basename(file.name)}`);
				await new Promise((y,n) => {
					arch.stream(file.name)
					.pipe(fs.createWriteStream(out))
					.on('error', n)
					.on('finish', y);
				});
				this.logSilly(`Extracted ${Path.basename(file.name)}`);
				results.push({
					srcPath: item.path,
					resultName: await this.filter.getOutputFile(out),
					path: out,
					extracted: 'rar'
				});
			}
		}
		
		if(this.delete) {
			await Misc.deleteFolder(item.path, Path.dirname(item.path) !== this.watch);
			this.logSilly(`Deleted Source ${Path.basename(item.path)}`);
		}
		
		return results;
	}
	
	async handleZip(item) {
		const arch = await Unzip.Open.file(item.path);
		const files = arch.files.filter((file) => {
			return file.type === 'File' && Misc.isMedia(file.name);
		});
		
		const results = [];
		for(const file of files) {
			const out = Path.join(this.out, Path.basename(file.name));
			if(await this.filter.checkPath(out)) {
				this.log(`Extracting ${Path.basename(file.name)}`);
				await new Promise((y,n) => {
					file.stream()
					.pipe(fs.createWriteStream(out))
					.on('error', n)
					.on('finish', y);
				});
				this.logSilly(`Extracted ${Path.basename(file.name)}`);
				
				results.push({
					srcPath: item.path,
					resultName: await this.filter.getOutputFile(out),
					path: out,
					extracted: 'rar'
				});
			}
		}
		
		if(this.delete) {
			await Misc.deleteFolder(item.path, Path.dirname(item.path) !== this.watch);
			this.logSilly(`Deleted Source ${Path.basename(item.path)}`);
		}
		
		return results;
	}
	
	async handleFile(item) {
		const out = Path.join(this.out, Path.basename(item.path));
		if(await this.filter.checkPath(out)) {
			if(this.delete) {
				this.log(`Moving ${Path.basename(item.path)}`);
				await fs.move(item.path, out, { overwrite: true });
				this.logSilly(`Moved ${Path.basename(item.path)}`);
				return [{
					srcPath: item.path,
					resultName: await this.filter.getOutputFile(out),
					path: out,
					extracted: false
				}];
			} else {
				this.log(`Copying ${Path.basename(item.path)}`);
				await fs.copy(item.path, out, { overwrite: true });
				this.logSilly(`Copied ${Path.basename(item.path)}`);
				return [{
					srcPath: item.path,
					resultName: await this.filter.getOutputFile(out),
					path: out,
					extracted: false
				}];
			}
		}
		this.logSilly(`Skipped ${Path.basename(item.path)}`);
		return [];
	}
}

module.exports = Extractor;