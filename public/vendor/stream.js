/**
 * vendor/stream.js — Node.js stream 的最小浏览器 polyfill(仅满足 jmuxer 初始化)。
 *
 * jmuxer.min.js 的 UMD 工厂需要 window.stream(顶层解构),即使浏览器环境
 * 实际不消费 stream(readable 端无人读取)。本 shim 提供 Duplex 的最小实现,
 * 使 new Duplex({...}) 不抛错即可;write/push 等在浏览器路径下不会被调用。
 */
(function (global) {
  "use strict";

  function noop() {}

  function Duplex(options) {
    if (!(this instanceof Duplex)) return new Duplex(options);
    options = options || {};
    this._writeFn = options.write;
    this._finalFn = options.final;
    this._readFn = options.read;
    this._writableObjectMode = !!options.writableObjectMode;
    this._readableState = { ended: false, flowing: null };
    this._writableState = { ended: false };
    this._events = {};
  }

  Duplex.prototype.push = function () {
    // 浏览器路径下无人消费可读端
    return true;
  };

  Duplex.prototype.write = function (chunk, enc, cb) {
    if (typeof enc === "function") {
      cb = enc;
      enc = null;
    }
    if (this._writeFn) {
      try {
        this._writeFn(chunk, enc || "utf8", cb || noop);
      } catch (e) {
        if (cb) cb(e);
      }
    } else if (cb) {
      cb();
    }
    return true;
  };

  Duplex.prototype.end = function (chunk, enc, cb) {
    if (typeof chunk === "function") {
      cb = chunk;
      chunk = null;
    } else if (typeof enc === "function") {
      cb = enc;
      enc = null;
    }
    if (chunk != null) this.write(chunk, enc || "utf8");
    if (this._finalFn) {
      try {
        this._finalFn(cb || noop);
      } catch (e) {
        if (cb) cb(e);
      }
    } else if (cb) {
      cb();
    }
    return this;
  };

  Duplex.prototype.on = function (evt, fn) {
    (this._events[evt] = this._events[evt] || []).push(fn);
    return this;
  };

  Duplex.prototype.once = function (evt, fn) {
    return this.on(evt, fn);
  };

  Duplex.prototype.removeListener = function () {
    return this;
  };

  Duplex.prototype.emit = function (evt) {
    var args = Array.prototype.slice.call(arguments, 1);
    (this._events[evt] || []).slice().forEach(function (f) {
      f.apply(null, args);
    });
    return this;
  };

  Duplex.prototype.pipe = function (dest) {
    return dest;
  };

  Duplex.prototype.resume = function () {
    return this;
  };

  Duplex.prototype.pause = function () {
    return this;
  };

  Duplex.prototype.setEncoding = function () {
    return this;
  };

  Duplex.prototype.destroy = function () {
    return this;
  };

  Duplex.prototype.read = function () {
    return null;
  };

  var Stream = Duplex;
  Stream.Readable = Duplex;
  Stream.Writable = Duplex;
  Stream.Duplex = Duplex;
  Stream.Stream = Duplex;
  global.stream = Stream;
})(typeof window !== "undefined" ? window : globalThis);
