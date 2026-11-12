const { build } = require('../package.json');
const { publish: _publish, ...buildWithoutPublish } = build;

const legacyMacBuild = {
  ...buildWithoutPublish,
  artifactName: 'orange-fuji-legacy.${ext}',
  electronVersion: '32.3.3',
  directories: {
    ...build.directories,
    output: 'dist/legacy',
  },
  mac: {
    ...build.mac,
    minimumSystemVersion: '10.15.0',
    target: [
      {
        target: 'dmg',
        arch: ['x64'],
      },
    ],
  },
};

module.exports = legacyMacBuild;
