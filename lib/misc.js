const fs = require('fs-extra');
const Path = require('path');

module.exports = {
	isMedia: (path) => {
		return /\.(3g2|3gp|3gpp|asf|avi|divx|f4v|flv|h264|ifo|m2ts|m4v|mkv|mod|mov|mp4|mpeg|mpg|mswmm|mts|mxf|ogv|rm|srt|swf|ts|vep|vob|webm|wlmp|wmv)$/
			.test(path);
	},
	deleteFolder: async (path, deleteParentFolder = false) => {
		const dir = Path.dirname(path);
		const ext = Path.extname(path);
		let filename = Path.basename(path, ext);
		if(ext === '.rar') {
			filename = filename.replace(/part[0-9]+$/,'');
		}
		
		const items = await fs.readdir(dir);
		const unrelatedItems = items.filter((item) => {
			const itemExt = Path.extname(path);
			let itemFilename = Path.basename(path, ext);
			if(itemExt === '.rar') {
				itemFilename = itemFilename.replace(/part[0-9]+$/,'');
			}
			return !/\.(nfo|sfv|jpg|txt)$/i.test(item)
				&& !/^(proof|sample|cover|subs|screens|readme)/ig.test(item)
				&& itemFilename !== filename;
		});
		if(!unrelatedItems.length && deleteParentFolder) {
			// In a folder without any unrelated items. Delete the whole folder
			return fs.remove(dir).catch(() => { /* ignore errors */ });
		} else {
			// There were possibly unrelated items. Just delete this one file.
			return fs.remove(path).catch(() => { /* ignore errors */ });
		}
	},
	fileExists: async (path) => {
		try {
			await fs.access(path);
			return true;
		} catch(err) {
			return false;
		}
	},
	padLeft: (nr, n, str) => {
		return (new Array(n - String(nr).length + 1)).join(str || '0') + nr;
	}
};