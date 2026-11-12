const { build } = require('../package.json');
const { publish: _publish, ...buildWithoutPublish } = build;

const catalinaMacBuild = {
  ...buildWithoutPublish,
  artifactName: 'orange-fuji-catalina.${ext}',
  electronVersion: '32.3.3',
  directories: {
    ...build.directories,
    output: 'dist/catalina',
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

module.exports = catalinaMacBuild;
