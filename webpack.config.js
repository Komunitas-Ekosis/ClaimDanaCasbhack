// Packages
const nodeExternals = require('webpack-node-externals')
const FlowBabelWebpackPlugin = require('flow-babel-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')

module.exports = {
  entry: './src/now.js',
  target: 'node',
  externals: [nodeExternals()],
  devtool: 'source-map',
  node: {
    __dirname: false
  },
  output: {
    filename: 'dist/now.js',
    // this makes sure that the pathnames in the stack traces
    // are correct, avoiding a webpack: prefix inside a segment
    devtoolModuleFilenameTemplate: '[absolute-resource-path]',
  },
  module: {
    rules: [{
      test: /\.js$/,
      exclude: /node_modules/,
      use: [
        { loader: 'shebang-loader' },
        { loader: 'babel-loader' }
      ]
    }]
  },
  plugins: [
    new FlowBabelWebpackPlugin(),
    new CopyWebpackPlugin([
      { from: 'src/serverless/handler.js', to: 'dist/handler.js' }
    ])
  ]
}
