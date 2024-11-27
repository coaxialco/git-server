const { createJsWithTsEsmPreset } = require('ts-jest');
const preset = createJsWithTsEsmPreset();

const jestConfig = {
  ...preset,
  verbose: true,
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

module.exports = jestConfig;
