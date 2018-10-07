const PipelineStep = require('../pipeline-step');
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
	}
	
	async process(items) {
		const toExtract = items.filter(({ path }) => {
			const ext = Path.extname(path).replace(/^\./,'');
			return Misc.isMedia(path)
				|| ext === 'zip'
				|| (ext === 'rar' && (!/part[0-9]+\.rar/.test(path)))
				|| /part0*1\.rar/.test(path);
		});
		
		let results = [];
		for(let item of toExtract) {
			const ext = Path.extname(item.path).replace(/^\./,'');
			if(ext === 'rar' && (!/part[0-9]+\.rar/.test(item.path)) || /part0*1\.rar/.test(item.path)) {
				results = results.concat(await this.handleRar(item));
			} else if(ext === 'zip') {
				results = results.concat(await this.handleZip(item));
			} else {
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
		
		return Promise.all(files.map(async (file) => {
			const out = Path.join(this.out, Path.basename(file.name));
			await new Promise((y,n) => {
				arch.stream(file.name)
				.pipe(fs.createWriteStream(out))
				.on('error', n)
				.on('finish', y);
			});
			this.log(`Extracted ${Path.basename(file.name)}`);
			if(this.delete) {
				await Misc.deleteFolder(item.path, Path.dirname(item.path) !== this.watch);
			}
			return {
				srcPath: item.path,
				path: out,
				extracted: 'rar'
			};
		}));
	}
	
	async handleZip(item) {
		return new Promise((y,n) => {
			const extracted = [];
			fs.createReadStream(item.path)
				.pipe(Unzip.Parse())
				.on('entry', (file) => {
					if(file.type === 'File' && Misc.isMedia(file.path)) {
						const out = Path.join(this.out, Path.basename(file.path));
						file.pipe(fs.createWriteStream(out));
						extracted.push({
							srcPath: item.path,
							path: out,
							extracted: 'zip'
						});
						this.log(`Extracted ${Path.basename(file.path)}`);
					} else {
						file.autodrain();
					}
				})
				.on('close', async () => {
					if(this.delete) {
						await Misc.deleteFolder(item.path, Path.dirname(item.path) !== this.watch);
					}
					
					y(extracted);
				})
				.on('error', n);
		});
	}
	
	async handleFile(item) {
		const out = Path.join(this.out, Path.basename(item.path));
		if(this.delete) {
			await fs.move(item.path, out, { overwrite: true });
			return [{
				srcPath: item.path,
				path: out,
				extracted: false
			}];
		} else {
			await fs.copy(item.path, out, { overwrite: true });
			return [{
				srcPath: item.path,
				path: out,
				extracted: false
			}];
		}
	}
}

module.exports = Extractor;