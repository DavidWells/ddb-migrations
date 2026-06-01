const util = require('util')
const path = require('path')
const config = require('configorama')
const options = require('minimist')(process.argv.slice(2))

const stack = config.sync(path.resolve(__dirname, 'stack.yml'), {
  options,
  allowUnknownVars: true,
})

console.log(util.inspect(stack, false, null, true))
module.exports = stack
