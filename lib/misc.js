const fs = require('fs-extra');
const Path = require('path');
const { spawn } = require('child_process');

const Misc = {
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
	},
	run(cmd, ...args) {
		return new Promise((y,n) => {
			let done = false;
			const once = (fnc) => (args) => { if(!done) { done = true; fnc(args); }};
			const proc = spawn(cmd, args);
			let stdout = '';
			let stderr = '';
			
			proc.stdout.on('data', (data) => stdout += data);
			proc.stderr.on('data', (data) => stderr += data);
			
			proc.on('error', once(n));
			proc.on('close', (code) => {
				if(code !== 0) {
					const err = new Error(`${cmd} exited with code (${code})`);
					err.code = code;
					err.stderr = stderr;
					return once(n)(err);
				}
				once(y)(stdout);
			});
		});
	},
	async mediaInfo(file) {
		const mediaInfo = JSON.parse(await Misc.run('mediainfo', '--Output=JSON', file));
		const result = {
			file: mediaInfo.media['@ref'],
			general: mediaInfo.media.track.find(t => t['@type'] === 'General')
		};
		// --- General ---
		// Dates
		['Encoded_Date','File_Modified_Date']
			.forEach((k) => { if(result.general[k]) result.general[k] = new Date(`${result.general[k].replace(/^UTC /, '')} UTC`); });
		// Integers
		['AudioCount','FileSize','Format_Version','FrameCount','OverallBitRate','StreamSize','VideoCount']
			.forEach((k) => { if(result.general[k]) result.general[k] = parseInt(result.general[k],10); });
		// Floats
		['Duration','FrameRate']
			.forEach((k) => { if(result.general[k]) result.general[k] = parseFloat(result.general[k]); });
		// Bools
		['IsStreamable']
			.forEach((k) => { if(result.general[k]) result.general[k] = result.general[k] === 'Yes' });
		
		// --- Audio ---
		const audios = mediaInfo.media.track.filter(t => t['@type'] === 'Audio');
		result.audio = audios.map((audio) => {
			// Integers
			['BitRate','Channels','FrameCount','ID','SamplesPerFrame','SamplingCount',
			 	'SamplingRate', 'StreamOrder','StreamSize']
				.forEach((k) => { if(audio[k]) audio[k] = parseInt(audio[k],10); });
			// Floats
			['Delay','Duration','FrameRate','StreamSize_Proportion']
				.forEach((k) => { if(audio[k]) audio[k] = parseFloat(audio[k]); });
			// Bools
			['Default','Forced']
				.forEach((k) => { if(audio[k]) audio[k] = audio[k] === 'Yes' });
			
			return audio;
		});
		// --- Video ---
		const videos = mediaInfo.media.track.filter(t => t['@type'] === 'Video');
		result.video = videos.map((video) => {
			// Integers
			['BitDepth','BitRate','Format_Settings_RefFrames','FrameCount','Height','Width','ID',
			 'Sampled_Height','Sampled_Width','StreamOrder','StreamSize']
			.forEach((k) => { if(video[k]) video[k] = parseInt(video[k],10); });
			// Floats
			['Delay','DisplayAspectRatio','Duration','FrameRate','PixelAspectRatio','StreamSize_Proportion']
			.forEach((k) => { if(video[k]) video[k] = parseFloat(video[k]); });
			// Bools
			['Default','Forced','Format_Settings_CABAC']
			.forEach((k) => { if(video[k]) video[k] = video[k] === 'Yes' });
			
			return video;
		});
		// --- Text ---
		const texts = mediaInfo.media.track.filter(t => t['@type'] === 'Text');
		result.text = texts.map((text) => {
			// Integers
			['BitRate','FrameCount','ElementCount','StreamSize']
			.forEach((k) => { if(text[k]) text[k] = parseInt(text[k],10); });
			// Floats
			['Duration','FrameRate']
			.forEach((k) => { if(text[k]) text[k] = parseFloat(text[k]); });
			// Bools
			['Default','Forced']
			.forEach((k) => { if(text[k]) text[k] = text[k] === 'Yes' });
			
			return text;
		});
		result.video.sort((a,b)=> (+a['@typeorder']) - (+b['@typeorder']));
		result.audio.sort((a,b)=> (+a['@typeorder']) - (+b['@typeorder']));
		result.text.sort((a,b)=> (+a['@typeorder']) - (+b['@typeorder']));
		
		return result;
	}
};

module.exports = Misc;