const Path = require('path');
const fs = require('fs-extra');
const os = require('os');
const Filter = require('./lib/media-filter');
const Misc = require('./lib/misc');

const config = require('./config.json');

(async () => {
  const finalConfig = Object.assign({}, config, {
    "output": '--',
    "movies": process.argv[4],
    "tv": process.argv[3]
  })

  const filter = new Filter(finalConfig);

  const files = fs.readdirSync(process.argv[2]);
  for(const file of files) {
    if(!Misc.isMedia(file) && !Misc.isArchive(file)) {
      continue;
    }
    const src = Path.join(process.argv[2], file);
    const result = await filter.getOutputFile(src);
    if(result && !/--/.test(result)) {
      console.log(result);
      await fs.move(src, result, { overwrite: true });
    }
  }
})();