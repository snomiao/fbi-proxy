#!/usr/bin/env bun
// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);

// node_modules/minimist/index.js
var require_minimist = __commonJS((exports, module) => {
  function hasKey(obj, keys) {
    var o = obj;
    keys.slice(0, -1).forEach(function(key2) {
      o = o[key2] || {};
    });
    var key = keys[keys.length - 1];
    return key in o;
  }
  function isNumber(x) {
    if (typeof x === "number") {
      return true;
    }
    if (/^0x[0-9a-f]+$/i.test(x)) {
      return true;
    }
    return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(e[-+]?\d+)?$/.test(x);
  }
  function isConstructorOrProto(obj, key) {
    return key === "constructor" && typeof obj[key] === "function" || key === "__proto__";
  }
  module.exports = function(args, opts) {
    if (!opts) {
      opts = {};
    }
    var flags = {
      bools: {},
      strings: {},
      unknownFn: null
    };
    if (typeof opts.unknown === "function") {
      flags.unknownFn = opts.unknown;
    }
    if (typeof opts.boolean === "boolean" && opts.boolean) {
      flags.allBools = true;
    } else {
      [].concat(opts.boolean).filter(Boolean).forEach(function(key2) {
        flags.bools[key2] = true;
      });
    }
    var aliases = {};
    function aliasIsBoolean(key2) {
      return aliases[key2].some(function(x) {
        return flags.bools[x];
      });
    }
    Object.keys(opts.alias || {}).forEach(function(key2) {
      aliases[key2] = [].concat(opts.alias[key2]);
      aliases[key2].forEach(function(x) {
        aliases[x] = [key2].concat(aliases[key2].filter(function(y) {
          return x !== y;
        }));
      });
    });
    [].concat(opts.string).filter(Boolean).forEach(function(key2) {
      flags.strings[key2] = true;
      if (aliases[key2]) {
        [].concat(aliases[key2]).forEach(function(k) {
          flags.strings[k] = true;
        });
      }
    });
    var defaults = opts.default || {};
    var argv = { _: [] };
    function argDefined(key2, arg2) {
      return flags.allBools && /^--[^=]+$/.test(arg2) || flags.strings[key2] || flags.bools[key2] || aliases[key2];
    }
    function setKey(obj, keys, value2) {
      var o = obj;
      for (var i2 = 0;i2 < keys.length - 1; i2++) {
        var key2 = keys[i2];
        if (isConstructorOrProto(o, key2)) {
          return;
        }
        if (o[key2] === undefined) {
          o[key2] = {};
        }
        if (o[key2] === Object.prototype || o[key2] === Number.prototype || o[key2] === String.prototype) {
          o[key2] = {};
        }
        if (o[key2] === Array.prototype) {
          o[key2] = [];
        }
        o = o[key2];
      }
      var lastKey = keys[keys.length - 1];
      if (isConstructorOrProto(o, lastKey)) {
        return;
      }
      if (o === Object.prototype || o === Number.prototype || o === String.prototype) {
        o = {};
      }
      if (o === Array.prototype) {
        o = [];
      }
      if (o[lastKey] === undefined || flags.bools[lastKey] || typeof o[lastKey] === "boolean") {
        o[lastKey] = value2;
      } else if (Array.isArray(o[lastKey])) {
        o[lastKey].push(value2);
      } else {
        o[lastKey] = [o[lastKey], value2];
      }
    }
    function setArg(key2, val, arg2) {
      if (arg2 && flags.unknownFn && !argDefined(key2, arg2)) {
        if (flags.unknownFn(arg2) === false) {
          return;
        }
      }
      var value2 = !flags.strings[key2] && isNumber(val) ? Number(val) : val;
      setKey(argv, key2.split("."), value2);
      (aliases[key2] || []).forEach(function(x) {
        setKey(argv, x.split("."), value2);
      });
    }
    Object.keys(flags.bools).forEach(function(key2) {
      setArg(key2, defaults[key2] === undefined ? false : defaults[key2]);
    });
    var notFlags = [];
    if (args.indexOf("--") !== -1) {
      notFlags = args.slice(args.indexOf("--") + 1);
      args = args.slice(0, args.indexOf("--"));
    }
    for (var i = 0;i < args.length; i++) {
      var arg = args[i];
      var key;
      var next;
      if (/^--.+=/.test(arg)) {
        var m = arg.match(/^--([^=]+)=([\s\S]*)$/);
        key = m[1];
        var value = m[2];
        if (flags.bools[key]) {
          value = value !== "false";
        }
        setArg(key, value, arg);
      } else if (/^--no-.+/.test(arg)) {
        key = arg.match(/^--no-(.+)/)[1];
        setArg(key, false, arg);
      } else if (/^--.+/.test(arg)) {
        key = arg.match(/^--(.+)/)[1];
        next = args[i + 1];
        if (next !== undefined && !/^(-|--)[^-]/.test(next) && !flags.bools[key] && !flags.allBools && (aliases[key] ? !aliasIsBoolean(key) : true)) {
          setArg(key, next, arg);
          i += 1;
        } else if (/^(true|false)$/.test(next)) {
          setArg(key, next === "true", arg);
          i += 1;
        } else {
          setArg(key, flags.strings[key] ? "" : true, arg);
        }
      } else if (/^-[^-]+/.test(arg)) {
        var letters = arg.slice(1, -1).split("");
        var broken = false;
        for (var j = 0;j < letters.length; j++) {
          next = arg.slice(j + 2);
          if (next === "-") {
            setArg(letters[j], next, arg);
            continue;
          }
          if (/[A-Za-z]/.test(letters[j]) && next[0] === "=") {
            setArg(letters[j], next.slice(1), arg);
            broken = true;
            break;
          }
          if (/[A-Za-z]/.test(letters[j]) && /-?\d+(\.\d*)?(e-?\d+)?$/.test(next)) {
            setArg(letters[j], next, arg);
            broken = true;
            break;
          }
          if (letters[j + 1] && letters[j + 1].match(/\W/)) {
            setArg(letters[j], arg.slice(j + 2), arg);
            broken = true;
            break;
          } else {
            setArg(letters[j], flags.strings[letters[j]] ? "" : true, arg);
          }
        }
        key = arg.slice(-1)[0];
        if (!broken && key !== "-") {
          if (args[i + 1] && !/^(-|--)[^-]/.test(args[i + 1]) && !flags.bools[key] && (aliases[key] ? !aliasIsBoolean(key) : true)) {
            setArg(key, args[i + 1], arg);
            i += 1;
          } else if (args[i + 1] && /^(true|false)$/.test(args[i + 1])) {
            setArg(key, args[i + 1] === "true", arg);
            i += 1;
          } else {
            setArg(key, flags.strings[key] ? "" : true, arg);
          }
        }
      } else {
        if (!flags.unknownFn || flags.unknownFn(arg) !== false) {
          argv._.push(flags.strings._ || !isNumber(arg) ? arg : Number(arg));
        }
        if (opts.stopEarly) {
          argv._.push.apply(argv._, args.slice(i + 1));
          break;
        }
      }
    }
    Object.keys(defaults).forEach(function(k) {
      if (!hasKey(argv, k.split("."))) {
        setKey(argv, k.split("."), defaults[k]);
        (aliases[k] || []).forEach(function(x) {
          setKey(argv, x.split("."), defaults[k]);
        });
      }
    });
    if (opts["--"]) {
      argv["--"] = notFlags.slice();
    } else {
      notFlags.forEach(function(k) {
        argv._.push(k);
      });
    }
    return argv;
  };
});

// node_modules/get-port/index.js
import net from "node:net";
import os from "node:os";

class Locked extends Error {
  constructor(port) {
    super(`${port} is locked`);
  }
}
var lockedPorts = {
  old: new Set,
  young: new Set
};
var releaseOldLockedPortsIntervalMs = 1000 * 15;
var timeout;
var getLocalHosts = () => {
  const interfaces = os.networkInterfaces();
  const results = new Set([undefined, "0.0.0.0"]);
  for (const _interface of Object.values(interfaces)) {
    for (const config of _interface) {
      results.add(config.address);
    }
  }
  return results;
};
var checkAvailablePort = (options) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.on("error", reject);
  server.listen(options, () => {
    const { port } = server.address();
    server.close(() => {
      resolve(port);
    });
  });
});
var getAvailablePort = async (options, hosts) => {
  if (options.host || options.port === 0) {
    return checkAvailablePort(options);
  }
  for (const host of hosts) {
    try {
      await checkAvailablePort({ port: options.port, host });
    } catch (error) {
      if (!["EADDRNOTAVAIL", "EINVAL"].includes(error.code)) {
        throw error;
      }
    }
  }
  return options.port;
};
var portCheckSequence = function* (ports) {
  if (ports) {
    yield* ports;
  }
  yield 0;
};
async function getPorts(options) {
  let ports;
  let exclude = new Set;
  if (options) {
    if (options.port) {
      ports = typeof options.port === "number" ? [options.port] : options.port;
    }
    if (options.exclude) {
      const excludeIterable = options.exclude;
      if (typeof excludeIterable[Symbol.iterator] !== "function") {
        throw new TypeError("The `exclude` option must be an iterable.");
      }
      for (const element of excludeIterable) {
        if (typeof element !== "number") {
          throw new TypeError("Each item in the `exclude` option must be a number corresponding to the port you want excluded.");
        }
        if (!Number.isSafeInteger(element)) {
          throw new TypeError(`Number ${element} in the exclude option is not a safe integer and can't be used`);
        }
      }
      exclude = new Set(excludeIterable);
    }
  }
  if (timeout === undefined) {
    timeout = setTimeout(() => {
      timeout = undefined;
      lockedPorts.old = lockedPorts.young;
      lockedPorts.young = new Set;
    }, releaseOldLockedPortsIntervalMs);
    if (timeout.unref) {
      timeout.unref();
    }
  }
  const hosts = getLocalHosts();
  for (const port of portCheckSequence(ports)) {
    try {
      if (exclude.has(port)) {
        continue;
      }
      let availablePort = await getAvailablePort({ ...options, port }, hosts);
      while (lockedPorts.old.has(availablePort) || lockedPorts.young.has(availablePort)) {
        if (port !== 0) {
          throw new Locked(port);
        }
        availablePort = await getAvailablePort({ ...options, port }, hosts);
      }
      lockedPorts.young.add(availablePort);
      return availablePort;
    } catch (error) {
      if (!["EADDRINUSE", "EACCES"].includes(error.code) && !(error instanceof Locked)) {
        throw error;
      }
    }
  }
  throw new Error("No available ports found");
}

// ts/cli.ts
var import_minimist = __toESM(require_minimist(), 1);

// node_modules/hot-memo/dist/index.js
var g = globalThis;
g["_HOTMEMO_SALT_"] ??= new Date().getTime().toString(36) + Math.random().toString(36).slice(2);
var cache = g["_HOTMEMO_CACHE_"] ??= new Map;
async function hotMemo(fn, args = [], key = `_HOTMEMO_${g["_HOTMEMO_SALT_"]}_${String(fn) + "(" + JSON.stringify(args) + ")"}`) {
  if (cache.has(key)) {
    return cache.get(key);
  }
  const result = await fn(...args);
  cache.set(key, result);
  return result;
}
hotMemo.cache = cache;

// ts/cli.ts
import { exec } from "child_process";
import path from "path";
import { exists } from "fs/promises";
var __dirname = "/code/snomiao/fbi-proxy/tree/main/ts";
if (!await Bun.$`caddy --version`.text().catch(() => "")) {
  console.error("Caddy is not installed. Please install Caddy first");
  console.error(`For windows, try running:
    choco install caddy
`);
  console.error(`For linux, try running:
    sudo apt install caddy
`);
  process.exit(1);
}
var argv = import_minimist.default(process.argv.slice(2), {});
console.log(argv);
var PROXY_PORT = String(await getPorts({ port: 24306 }));
var proxyProcess = await hotMemo(async () => {
  console.log("Starting Rust proxy server");
  const p = exec(`cargo watch -x "run --bin proxy"`, {
    env: {
      ...process.env,
      PROXY_PORT
    },
    cwd: path.join(__dirname, "../rs")
  });
  p.stdout?.pipe(process.stdout, { end: false });
  p.stderr?.pipe(process.stderr, { end: false });
  p.on("exit", (code) => {
    console.log(`Proxy server exited with code ${code}`);
    process.exit(code || 0);
  });
  console.log("Rust proxy server started on port 24306");
  return p;
});
var caddyProcess = await hotMemo(async () => {
  const Caddyfile = path.join(__dirname, "../Caddyfile");
  if (!await exists(Caddyfile).catch(() => false)) {
    console.error("Caddyfile not found at " + Caddyfile);
    console.error("Please create a Caddyfile in the root directory of the project.");
    process.exit(1);
  }
  console.log("Starting Caddy");
  const p = exec(`caddy run --watch --config ${Caddyfile}`, {
    env: {
      ...process.env,
      PROXY_PORT,
      TLS: argv.tls || "internal"
    },
    cwd: path.dirname(Caddyfile)
  });
  p.stdout?.pipe(process.stdout, { end: false });
  p.stderr?.pipe(process.stderr, { end: false });
  p.on("exit", (code) => process.exit(code || 0));
  console.log("Caddy started with config at " + Caddyfile);
  return p;
});
console.log("all done");
var exit = () => {
  console.log("Shutting down...");
  proxyProcess?.kill?.();
  caddyProcess?.kill?.();
  process.exit(0);
};
process.on("SIGINT", exit);
process.on("SIGTERM", exit);
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  exit();
});
