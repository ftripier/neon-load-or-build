var fs = require('fs')
var path = require('path')
var os = require('os')

// Workaround to fix webpack's build warnings: 'the request of a dependency is an expression'
var runtimeRequire = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require // eslint-disable-line

var vars = (process.config && process.config.variables) || {}
var prebuildsOnly = !!process.env.PREBUILDS_ONLY
var abi = process.versions.modules // TODO: support old node where this is undef
var runtime = isElectron() ? 'electron' : 'node'
var arch = os.arch()
var platform = os.platform()
var libc = process.env.LIBC || (isAlpine(platform) ? 'musl' : 'glibc')
var armv = process.env.ARM_VERSION || (arch === 'arm64' ? '8' : vars.arm_version) || ''
var uv = (process.versions.uv || '').split('.')[0]

module.exports = load

function load (opts) {
  var dir
  if (opts && opts.moduleName && (platform === 'ios' || platform === 'android')) {
    dir = path.resolve(getRoot(getFileName()), 'node_modules', opts.moduleName)
  } else {
    dir = (opts && opts.dir) || opts || '.'
  }
  return runtimeRequire(load.path(dir))
}

load.path = function (dir) {
  console.log("LOAD PATH");
  dir = path.resolve(dir)
  console.log({ dir });
  try {
    var name = runtimeRequire(path.join(dir, 'package.json')).name.toUpperCase().replace(/-/g, '_')
    console.log({ name });
    if (process.env[name + '_PREBUILD']) dir = process.env[name + '_PREBUILD']
    console.log({ dir });
  } catch (err) {}

  if (!prebuildsOnly) {
    var localBuild = getFirst(path.join(dir, 'native'), matchBuild)
    console.log({ localBuild });
    if (localBuild) return localBuild
  }

  var prebuild = resolve(dir)
  console.log({ prebuild });
  if (prebuild) return prebuild

  var nearby = resolve(path.dirname(process.execPath))
  console.log({ nearby });
  if (nearby) return nearby

  var target = [
    'platform=' + platform,
    'arch=' + arch,
    'runtime=' + runtime,
    'abi=' + abi,
    'uv=' + uv,
    armv ? 'armv=' + armv : '',
    'libc=' + libc,
    'node=' + process.versions.node,
    (process.versions && process.versions.electron) ? 'electron=' + process.versions.electron : '',
    typeof __webpack_require__ === 'function' ? 'webpack=true' : '' // eslint-disable-line
  ].filter(Boolean).join(' ')

  throw new Error('No native build was found for ' + target + '\n    loaded from: ' + dir + '\n')

  function resolve (dir) {
    // Find most specific flavor first
    var prebuilds = path.join(dir, 'prebuilds', platform + '-' + arch)
    console.log({ dir, prebuilds });
    var parsed = readdirSync(prebuilds).map(parseTags)
    console.log({ parsed });
    console.log({ tags: matchTags(runtime, abi), runtime, abi });
    var candidates = parsed.filter(matchTags(runtime, abi))
    console.log({ candidates });
    console.log({ compared: compareTags(runtime) });
    var winner = candidates.sort(compareTags(runtime))[0];
    console.log({ winner });
    if (winner) return path.join(prebuilds, winner.file)
  }
}

function readdirSync (dir) {
  try {
    return fs.readdirSync(dir)
  } catch (err) {
    return []
  }
}

function getFirst (dir, filter) {
  var files = readdirSync(dir).filter(filter)
  return files[0] && path.join(dir, files[0])
}

function matchBuild (name) {
  return /\.node$/.test(name)
}

var exists = ((fs.accessSync && function (path) { try { fs.accessSync(path) } catch (e) { return false } return true }) ||
  fs.existsSync || path.existsSync)

/**
 * Gets the filename of the JavaScript file that invokes this function.
 * Used to help find the root directory of a module.
 * Optionally accepts an filename argument to skip when searching for the invoking filename
 */
function getFileName (callingFile) {
  var origPST = Error.prepareStackTrace
  var origSTL = Error.stackTraceLimit
  var dummy = {}
  var fileName

  Error.stackTraceLimit = 10

  Error.prepareStackTrace = function (e, st) {
    for (var i = 0, l = st.length; i < l; i++) {
      fileName = st[i].getFileName()
      if (fileName !== __filename) {
        if (callingFile) {
          if (fileName !== callingFile) {
            return
          }
        } else {
          return
        }
      }
    }
  }

  // run the 'prepareStackTrace' function above
  Error.captureStackTrace(dummy)
  dummy.stack // eslint-disable-line

  // cleanup
  Error.prepareStackTrace = origPST
  Error.stackTraceLimit = origSTL

  return fileName
}

/**
 * Gets the root directory of a module, given an arbitrary filename
 * somewhere in the module tree. The "root directory" is the directory
 * containing the `package.json` file.
 *
 *   In:  /home/nate/node-native-module/lib/index.js
 *   Out: /home/nate/node-native-module
 */
function getRoot (file) {
  var dir = path.dirname(file)
  var prev
  while (true) {
    if (dir === '.') {
      // Avoids an infinite loop in rare cases, like the REPL
      dir = process.cwd()
    }
    if (exists(path.join(dir, 'package.json')) || exists(path.join(dir, 'node_modules'))) {
      // Found the 'package.json' file or 'node_modules' dir; we're done
      return dir
    }
    if (prev === dir) {
      // Got to the top
      throw new Error('Could not find module root given file: "' + file +
        '". Do you have a `package.json` file? ')
    }
    // Try the parent dir next
    prev = dir
    dir = path.join(dir, '..')
  }
}

function parseTags (file) {
  var arr = file.split('.')
  var extension = arr.pop()
  var tags = { file: file, specificity: 0 }

  if (extension !== 'node') return

  for (var i = 0; i < arr.length; i++) {
    var tag = arr[i]

    if (tag === 'node' || tag === 'electron' || tag === 'node-webkit') {
      tags.runtime = tag
    } else if (tag === 'napi') {
      tags.napi = true
    } else if (tag.slice(0, 3) === 'abi') {
      tags.abi = tag.slice(3)
    } else if (tag.slice(0, 2) === 'uv') {
      tags.uv = tag.slice(2)
    } else if (tag.slice(0, 4) === 'armv') {
      tags.armv = tag.slice(4)
    } else if (tag === 'glibc' || tag === 'musl') {
      tags.libc = tag
    } else {
      continue
    }

    tags.specificity++
  }

  return tags
}

function matchTags (runtime, abi) {
  return function (tags) {
    if (tags == null) return false
    if (tags.runtime !== runtime && !runtimeAgnostic(tags)) return false
    if (tags.abi !== abi && !tags.napi) return false
    if (tags.uv && tags.uv !== uv) return false
    if (tags.armv && tags.armv !== armv) return false
    if (tags.libc && tags.libc !== libc) return false

    return true
  }
}

function runtimeAgnostic (tags) {
  return tags.runtime === 'node' && tags.napi
}

function compareTags (runtime) {
  // Precedence: non-agnostic runtime, abi over napi, then by specificity.
  return function (a, b) {
    if (a.runtime !== b.runtime) {
      return a.runtime === runtime ? -1 : 1
    } else if (a.abi !== b.abi) {
      return a.abi ? -1 : 1
    } else if (a.specificity !== b.specificity) {
      return a.specificity > b.specificity ? -1 : 1
    } else {
      return 0
    }
  }
}

function isElectron () {
  if (process.versions && process.versions.electron) return true
  if (process.env.ELECTRON_RUN_AS_NODE) return true
  return typeof window !== 'undefined' && window.process && window.process.type === 'renderer'
}

function isAlpine (platform) {
  return platform === 'linux' && fs.existsSync('/etc/alpine-release')
}

// Exposed for unit tests
// TODO: move to lib
load.parseTags = parseTags
load.matchTags = matchTags
load.compareTags = compareTags
