/*!
 * lowlevelup.js - LevelUP module for bcoin
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('assert');
const Key = require('./key');

/**
 * Constants
 */

const LOW = Buffer.alloc(1, 0x00);
const HIGH = Buffer.alloc(255, 0xff);
const DUMMY = Buffer.alloc(0);

let VERSION_ERROR = null;

/**
 * LowLevelUp
 */

class LowLevelUp {
  /**
   * Create an LLU instance.
   * @constructor
   * @param {Function} backend - Database backend.
   * @param {String} location - File location.
   * @param {Object?} options - Leveldown options.
   */

  constructor(backend, location, options) {
    assert(typeof backend === 'function', 'Backend is required.');
    assert(typeof location === 'string', 'Filename is required.');

    this.options = new LLUOptions(options);
    this.backend = backend;
    this.location = location;

    this.loading = false;
    this.closing = false;
    this.loaded = false;

    this.binding = null;
    this.leveldown = false;

    this.init();
  }

  /**
   * Initialize the database.
   * @private
   */

  init() {
    const Backend = this.backend;

    let db = new Backend(this.location);

    // Stay as close to the metal as possible.
    // We want to make calls to C++ directly.
    while (db.db) {
      // Not a database.
      if (typeof db.db.put !== 'function')
        break;

      // Recursive.
      if (db.db === db)
        break;

      // Go deeper.
      db = db.db;
    }

    // A lower-level binding.
    if (db.binding) {
      this.binding = db.binding;
      this.leveldown = db !== db.binding;
    } else {
      this.binding = db;
    }
  }

  /**
   * Create a key.
   * @param {Number} id
   * @param {Array?} args
   * @returns {Key}
   */

  key(id, args) {
    return new Key(id, args);
  }

  /**
   * Open the database.
   * @returns {Promise}
   */

  async open() {
    if (this.loaded)
      throw new Error('Database is already open.');

    assert(!this.loading);
    assert(!this.closing);

    try {
      this.loading = true;
      await this.load();
    } finally {
      this.loading = false;
    }

    this.loaded = true;
  }

  /**
   * Close the database.
   * @returns {Promise}
   */

  async close() {
    if (!this.loaded)
      throw new Error('Database is already closed.');

    assert(!this.loading);
    assert(!this.closing);

    try {
      this.loaded = false;
      this.closing = true;
      await this.unload();
    } catch (e) {
      this.loaded = true;
      throw e;
    } finally {
      this.closing = false;
    }
  }

  /**
   * Open the database.
   * @private
   * @returns {Promise}
   */

  load() {
    return new Promise((resolve, reject) => {
      this.binding.open(this.options, wrap(resolve, reject));
    });
  }

  /**
   * Close the database.
   * @private
   * @returns {Promise}
   */

  unload() {
    return new Promise((resolve, reject) => {
      this.binding.close(wrap(resolve, reject));
    });
  }

  /**
   * Destroy the database.
   * @returns {Promise}
   */

  destroy() {
    return new Promise((resolve, reject) => {
      if (this.loaded || this.closing) {
        reject(new Error('Cannot destroy open database.'));
        return;
      }

      if (!this.backend.destroy) {
        reject(new Error('Cannot destroy (method not available).'));
        return;
      }

      this.backend.destroy(this.location, wrap(resolve, reject));
    });
  }

  /**
   * Repair the database.
   * @returns {Promise}
   */

  repair() {
    return new Promise((resolve, reject) => {
      if (this.loaded || this.closing) {
        reject(new Error('Cannot repair open database.'));
        return;
      }

      if (!this.backend.repair) {
        reject(new Error('Cannot repair (method not available).'));
        return;
      }

      this.backend.repair(this.location, wrap(resolve, reject));
    });
  }

  /**
   * Backup the database.
   * @param {String} path
   * @returns {Promise}
   */

  backup(path) {
    if (!this.binding.backup)
      return this.clone(path);

    return new Promise((resolve, reject) => {
      if (!this.loaded) {
        reject(new Error('Database is closed.'));
        return;
      }
      this.binding.backup(path, wrap(resolve, reject));
    });
  }

  /**
   * Create a bucket.
   * @param {Buffer} prefix
   * @returns {Bucket}
   */

  bucket(prefix) {
    return new Bucket(this, prefix);
  }

  /**
   * Get root bucket.
   * @returns {Bucket}
   */

  root() {
    return this;
  }

  /**
   * Get child bucket.
   * @param {Buffer} prefix
   * @returns {Bucket}
   */

  child(prefix) {
    return this.bucket(prefix);
  }

  /**
   * Wrap a batch or iterator.
   * @param {Object} obj
   * @returns {Object}
   */

  wrap(obj) {
    return obj.root();
  }

  /**
   * Retrieve a record from the database.
   * @param {String|Buffer} key
   * @returns {Promise} - Returns Buffer.
   */

  get(key) {
    return new Promise((resolve, reject) => {
      if (!this.loaded) {
        reject(new Error('Database is closed.'));
        return;
      }
      this.binding.get(key, (err, result) => {
        if (err) {
          if (isNotFound(err)) {
            resolve(null);
            return;
          }
          reject(err);
          return;
        }
        resolve(result);
      });
    });
  }

  /**
   * Store a record in the database.
   * @param {String|Buffer} key
   * @param {Buffer} value
   * @returns {Promise}
   */

  put(key, value) {
    if (!value)
      value = LOW;

    return new Promise((resolve, reject) => {
      if (!this.loaded) {
        reject(new Error('Database is closed.'));
        return;
      }
      this.binding.put(key, value, wrap(resolve, reject));
    });
  }

  /**
   * Remove a record from the database.
   * @param {String|Buffer} key
   * @returns {Promise}
   */

  del(key) {
    return new Promise((resolve, reject) => {
      if (!this.loaded) {
        reject(new Error('Database is closed.'));
        return;
      }
      this.binding.del(key, wrap(resolve, reject));
    });
  }

  /**
   * Create an atomic batch.
   * @returns {Batch}
   */

  batch() {
    if (!this.loaded)
      throw new Error('Database is closed.');

    return new Batch(this.binding.batch());
  }

  /**
   * Create an iterator.
   * @param {Object} options
   * @returns {Iterator}
   */

  iterator(options) {
    if (!this.loaded)
      throw new Error('Database is closed.');

    return new Iterator(this, options);
  }

  /**
   * Get a database property.
   * @param {String} name - Property name.
   * @returns {String}
   */

  getProperty(name) {
    if (!this.loaded)
      throw new Error('Database is closed.');

    if (!this.binding.getProperty)
      return '';

    return this.binding.getProperty(name);
  }

  /**
   * Calculate approximate database size.
   * @param {String|Buffer} start - Start key.
   * @param {String|Buffer} end - End key.
   * @returns {Promise} - Returns Number.
   */

  approximateSize(start, end) {
    return new Promise((resolve, reject) => {
      if (!this.loaded) {
        reject(new Error('Database is closed.'));
        return;
      }

      if (!this.binding.approximateSize) {
        reject(new Error('Cannot get size.'));
        return;
      }

      this.binding.approximateSize(start, end, wrap(resolve, reject));
    });
  }

  /**
   * Compact range of keys.
   * @param {String|Buffer|null} start - Start key.
   * @param {String|Buffer|null} end - End key.
   * @returns {Promise}
   */

  compactRange(start, end) {
    if (!start)
      start = LOW;

    if (!end)
      end = HIGH;

    return new Promise((resolve, reject) => {
      if (!this.loaded) {
        reject(new Error('Database is closed.'));
        return;
      }

      if (!this.binding.compactRange) {
        resolve();
        return;
      }

      this.binding.compactRange(start, end, wrap(resolve, reject));
    });
  }

  /**
   * Test whether a key exists.
   * @param {String} key
   * @returns {Promise} - Returns Boolean.
   */

  async has(key) {
    const value = await this.get(key);
    return value != null;
  }

  /**
   * Collect all keys from iterator options.
   * @param {Object} options - Iterator options.
   * @returns {Promise} - Returns Array.
   */

  range(options = {}) {
    const iter = this.iterator({
      gte: options.gte,
      lte: options.lte,
      keys: true,
      values: true
    });
    return iter.range(options.parse);
  }

  /**
   * Collect all keys from iterator options.
   * @param {Object} options - Iterator options.
   * @returns {Promise} - Returns Array.
   */

  keys(options = {}) {
    const iter = this.iterator({
      gte: options.gte,
      lte: options.lte,
      keys: true,
      values: false
    });
    return iter.keys(options.parse);
  }

  /**
   * Collect all keys from iterator options.
   * @param {Object} options - Iterator options.
   * @returns {Promise} - Returns Array.
   */

  values(options = {}) {
    const iter = this.iterator({
      gte: options.gte,
      lte: options.lte,
      keys: false,
      values: true
    });
    return iter.values(options.parse);
  }

  /**
   * Dump database (for debugging).
   * @returns {Promise} - Returns Object.
   */

  async dump() {
    const records = Object.create(null);

    const items = await this.range({
      gte: LOW,
      lte: HIGH
    });

    for (const item of items) {
      const key = item.key.toString('hex');
      const value = item.value.toString('hex');
      records[key] = value;
    }

    return records;
  }

  /**
   * Write and assert a version number for the database.
   * @param {Number} version
   * @returns {Promise}
   */

  async checkVersion(key, version) {
    const data = await this.get(key);

    if (!data) {
      const value = Buffer.allocUnsafe(4);
      value.writeUInt32LE(version, 0, true);
      const batch = this.batch();
      batch.put(key, value);
      await batch.write();
      return;
    }

    const num = data.readUInt32LE(0, true);

    if (num !== version)
      throw new Error(VERSION_ERROR);
  }

  /**
   * Clone the database.
   * @param {String} path
   * @returns {Promise}
   */

  async clone(path) {
    if (!this.loaded)
      throw new Error('Database is closed.');

    const hwm = 256 << 20;

    const options = new LLUOptions(this.options);
    options.createIfMissing = true;
    options.errorIfExists = true;

    const tmp = new LowLevelUp(this.backend, path, options);

    await tmp.open();

    const iter = this.iterator({
      keys: true,
      values: true
    });

    let batch = tmp.batch();
    let total = 0;

    while (await iter.next()) {
      const {key, value} = iter;

      batch.put(key, value);

      total += key.length + 80;
      total += value.length + 80;

      if (total >= hwm) {
        total = 0;

        try {
          await batch.write();
        } catch (e) {
          await iter.end();
          await tmp.close();
          throw e;
        }

        batch = tmp.batch();
      }
    }

    try {
      await batch.write();
    } finally {
      await tmp.close();
    }
  }
}

/**
 * Batch
 */

class Batch {
  /**
   * Create a batch.
   * @constructor
   * @ignore
   * @param {Object} binding
   * @param {Buffer} [prefix=null]
   */

  constructor(binding, prefix) {
    this.binding = binding;
    this.prefix = prefix || null;
  }

  /**
   * Get bucket.
   * @returns {Batch}
   */

  bucket(prefix) {
    return new Batch(this.binding, prefix);
  }

  /**
   * Get root batch.
   * @returns {Batch}
   */

  root() {
    return this.bucket(null);
  }

  /**
   * Get child batch.
   * @param {Buffer} prefix
   * @returns {Batch}
   */

  child(prefix) {
    return this.bucket(concat(this.prefix, prefix));
  }

  /**
   * Wrap a batch or iterator.
   * @param {Object} obj
   * @returns {Object}
   */

  wrap(obj) {
    return obj.bucket(this.prefix);
  }

  /**
   * Write a value to the batch.
   * @param {String|Buffer} key
   * @param {Buffer} value
   */

  put(key, value) {
    if (!value)
      value = LOW;

    this.binding.put(concat(this.prefix, key), value);

    return this;
  }

  /**
   * Delete a value from the batch.
   * @param {String|Buffer} key
   */

  del(key) {
    this.binding.del(concat(this.prefix, key));
    return this;
  }

  /**
   * Write batch to database.
   * @returns {Promise}
   */

  write() {
    return new Promise((resolve, reject) => {
      this.binding.write(wrap(resolve, reject));
    });
  }

  /**
   * Clear the batch.
   */

  clear() {
    this.binding.clear();
    return this;
  }
}

/**
 * Bucket
 */

class Bucket {
  /**
   * Create a bucket.
   * @constructor
   * @ignore
   * @param {LowLevelUp} db
   * @param {Batch} batch
   * @param {Buffer} prefix
   */

  constructor(db, prefix) {
    this.db = db;
    this.prefix = prefix || null;
  }

  /**
   * Get bucket.
   * @param {Buffer} prefix
   * @returns {Bucket}
   */

  bucket(prefix) {
    return new Bucket(this.db, prefix);
  }

  /**
   * Get root bucket.
   * @returns {Bucket}
   */

  root() {
    return this.bucket(null);
  }

  /**
   * Get child bucket.
   * @param {Buffer} prefix
   * @returns {Bucket}
   */

  child(prefix) {
    return this.bucket(concat(this.prefix, prefix));
  }

  /**
   * Wrap a batch or iterator.
   * @param {Object} obj
   * @returns {Object}
   */

  wrap(obj) {
    return obj.bucket(this.prefix);
  }

  /**
   * Create a batch.
   * @returns {Batch}
   */

  batch() {
    return new Batch(this.db.binding.batch(), this.prefix);
  }

  /**
   * Get a value from the bucket.
   * @param {String|Buffer} key
   * @returns {Promise}
   */

  has(key) {
    return this.db.has(concat(this.prefix, key));
  }

  /**
   * Get a value from the bucket.
   * @param {String|Buffer} key
   * @returns {Promise}
   */

  get(key) {
    return this.db.get(concat(this.prefix, key));
  }

  /**
   * Create an iterator.
   * @param {Object} options
   * @returns {Iterator}
   */

  iterator(options) {
    return new Iterator(this.db, options, this.prefix);
  }

  /**
   * Collect all keys from iterator options.
   * @param {Object} options - Iterator options.
   * @returns {Promise} - Returns Array.
   */

  range(options = {}) {
    const iter = this.iterator({
      gte: options.gte,
      lte: options.lte,
      keys: true,
      values: true
    });
    return iter.range(options.parse);
  }

  /**
   * Collect all keys from iterator options.
   * @param {Object} options - Iterator options.
   * @returns {Promise} - Returns Array.
   */

  keys(options = {}) {
    const iter = this.iterator({
      gte: options.gte,
      lte: options.lte,
      keys: true,
      values: false
    });
    return iter.keys(options.parse);
  }

  /**
   * Collect all keys from iterator options.
   * @param {Object} options - Iterator options.
   * @returns {Promise} - Returns Array.
   */

  values(options = {}) {
    const iter = this.iterator({
      gte: options.gte,
      lte: options.lte,
      keys: false,
      values: true
    });
    return iter.values(options.parse);
  }
}

/**
 * Iterator
 */

class Iterator {
  /**
   * Create an iterator.
   * @constructor
   * @ignore
   * @param {LowLevelUp} db
   * @param {Object} [options=null]
   * @param {Buffer} [prefix=null]
   */

  constructor(db, options, prefix) {
    this.db = db;
    this.options = options || null;
    this.prefix = prefix || null;

    this.binding = null;
    this.cache = [];
    this.finished = false;

    this.key = null;
    this.value = null;
    this.valid = true;
  }

  /**
   * Start the iterator.
   */

  start() {
    if (this.binding)
      return;

    const options = new IteratorOptions(this.options);

    if (options.gte != null)
      options.gte = concat(this.prefix, options.gte);

    if (options.lte != null)
      options.lte = concat(this.prefix, options.lte);

    if (options.gt != null)
      options.gt = concat(this.prefix, options.gt);

    if (options.lt != null)
      options.lt = concat(this.prefix, options.lt);

    if (this.prefix != null) {
      assert(Buffer.isBuffer(this.prefix) || typeof this.prefix === 'string');

      if (options.gt == null && options.gte == null)
        options.gte = this.prefix;

      if (options.lt == null && options.lte == null)
        options.lt = increment(this.prefix);
    }

    options.keyAsBuffer = Key.buffer;

    this.binding = this.db.binding.iterator(options);
  }

  /**
   * Get bucket.
   * @param {Buffer} prefix
   * @returns {Iterator}
   */

  bucket(prefix) {
    assert(!this.binding);
    return new Iterator(this.db, this.options, prefix);
  }

  /**
   * Get root iterator.
   * @returns {Iterator}
   */

  root() {
    return this.bucket(null);
  }

  /**
   * Get child iterator.
   * @param {Buffer} prefix
   * @returns {Iterator}
   */

  child(prefix) {
    return this.bucket(concat(this.prefix, prefix));
  }

  /**
   * Wrap a batch or iterator.
   * @param {Object} obj
   * @returns {Object}
   */

  wrap(obj) {
    return obj.bucket(this.prefix);
  }

  /**
   * Clean up iterator.
   * @private
   */

  cleanup() {
    this.cache = [];
    this.finished = true;
    this.key = null;
    this.value = null;
    this.valid = false;
  }

  /**
   * For each.
   * @returns {Promise}
   */

  async each(cb) {
    assert(this.valid);

    while (!this.finished) {
      await this.read();

      while (this.cache.length > 0) {
        const key = slice(this.prefix, this.cache.pop());
        const value = this.cache.pop();

        let result = null;

        try {
          result = cb(key, value);

          if (result instanceof Promise)
            result = await result;
        } catch (e) {
          await this.end();
          throw e;
        }

        if (result === false) {
          await this.end();
          break;
        }
      }
    }
  }

  /**
   * Seek to the next key.
   * @returns {Promise}
   */

  async next() {
    assert(this.valid);

    if (!this.finished) {
      if (this.cache.length === 0)
        await this.read();
    }

    if (this.cache.length > 0) {
      this.key = slice(this.prefix, this.cache.pop());
      this.value = this.cache.pop();
      return true;
    }

    assert(this.finished);

    this.cleanup();

    return false;
  }

  /**
   * Seek to the next key (buffer values).
   * @private
   * @returns {Promise}
   */

  read() {
    return new Promise((resolve, reject) => {
      if (!this.binding) {
        try {
          this.start();
        } catch (e) {
          reject(e);
          return;
        }
      }

      if (!this.db.leveldown) {
        this.binding.next((err, key, value) => {
          if (err) {
            this.cleanup();
            this.binding.end(() => reject(err));
            return;
          }

          if (key === undefined && value === undefined) {
            this.cleanup();
            this.binding.end(wrap(resolve, reject));
            return;
          }

          this.cache = [value, key];

          resolve();
        });
        return;
      }

      this.binding.next((err, cache, finished) => {
        if (err) {
          this.cleanup();
          this.binding.end(() => reject(err));
          return;
        }

        this.cache = cache;
        this.finished = finished;

        resolve();
      });
    });
  }

  /**
   * Seek to an arbitrary key.
   * @param {String|Buffer} key
   */

  seek(key) {
    assert(this.valid);
    this.start();
    this.binding.seek(key);
    return this;
  }

  /**
   * End the iterator.
   * @returns {Promise}
   */

  end() {
    return new Promise((resolve, reject) => {
      if (!this.binding) {
        try {
          this.start();
        } catch (e) {
          reject(e);
          return;
        }
      }
      this.cleanup();
      this.binding.end(wrap(resolve, reject));
    });
  }

  /**
   * Collect all keys and values from iterator options.
   * @param {Function} parse
   * @returns {Promise} - Returns Array.
   */

  async range(parse) {
    const items = [];

    await this.each((key, value) => {
      if (parse) {
        const item = parse(key, value);
        if (item)
          items.push(item);
      } else {
        items.push(new IteratorItem(key, value));
      }
    });

    return items;
  }

  /**
   * Collect all keys from iterator options.
   * @param {Function} parse
   * @returns {Promise} - Returns Array.
   */

  async keys(parse) {
    const items = [];

    await this.each((key, value) => {
      if (parse)
        key = parse(key);
      items.push(key);
    });

    return items;
  }

  /**
   * Collect all values from iterator options.
   * @param {Function} parse
   * @returns {Promise} - Returns Array.
   */

  async values(parse) {
    const items = [];

    await this.each((key, value) => {
      if (parse)
        value = parse(value);
      items.push(value);
    });

    return items;
  }
}

/**
 * Iterator Item
 */

class IteratorItem {
  /**
   * Create an iterator item.
   * @constructor
   * @ignore
   * @param {String|Buffer} key
   * @param {String|Buffer} value
   * @property {String|Buffer} key
   * @property {String|Buffer} value
   */

  constructor(key, value) {
    this.key = key;
    this.value = value;
  }
}

/**
 * LLUOptions
 */

class LLUOptions {
  /**
   * Create LLU Options.
   * @constructor
   * @ignore
   * @param {Object} options
   */

  constructor(options) {
    this.createIfMissing = true;
    this.errorIfExists = false;
    this.compression = true;
    this.cacheSize = 8 << 20;
    this.writeBufferSize = 4 << 20;
    this.maxOpenFiles = 64;
    this.maxFileSize = 2 << 20;
    this.paranoidChecks = false;
    this.memory = false;
    this.sync = false;
    this.mapSize = 256 * (1024 << 20);
    this.writeMap = false;
    this.noSubdir = true;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options.
   * @private
   * @param {Object} options
   * @returns {LLUOptions}
   */

  fromOptions(options) {
    assert(options, 'Options are required.');

    if (options.createIfMissing != null) {
      assert(typeof options.createIfMissing === 'boolean',
        '`createIfMissing` must be a boolean.');
      this.createIfMissing = options.createIfMissing;
    }

    if (options.errorIfExists != null) {
      assert(typeof options.errorIfExists === 'boolean',
        '`errorIfExists` must be a boolean.');
      this.errorIfExists = options.errorIfExists;
    }

    if (options.compression != null) {
      assert(typeof options.compression === 'boolean',
        '`compression` must be a boolean.');
      this.compression = options.compression;
    }

    if (options.cacheSize != null) {
      assert(typeof options.cacheSize === 'number',
        '`cacheSize` must be a number.');
      assert(options.cacheSize >= 0);
      this.cacheSize = Math.floor(options.cacheSize / 2);
      this.writeBufferSize = Math.floor(options.cacheSize / 4);
    }

    if (options.maxFiles != null) {
      assert(typeof options.maxFiles === 'number',
        '`maxFiles` must be a number.');
      assert(options.maxFiles >= 0);
      this.maxOpenFiles = options.maxFiles;
    }

    if (options.maxFileSize != null) {
      assert(typeof options.maxFileSize === 'number',
        '`maxFileSize` must be a number.');
      assert(options.maxFileSize >= 0);
      this.maxFileSize = options.maxFileSize;
    }

    if (options.paranoidChecks != null) {
      assert(typeof options.paranoidChecks === 'boolean',
        '`paranoidChecks` must be a boolean.');
      this.paranoidChecks = options.paranoidChecks;
    }

    if (options.memory != null) {
      assert(typeof options.memory === 'boolean',
        '`memory` must be a boolean.');
      this.memory = options.memory;
    }

    if (options.sync != null) {
      assert(typeof options.sync === 'boolean',
        '`sync` must be a boolean.');
      this.sync = options.sync;
    }

    if (options.mapSize != null) {
      assert(typeof options.mapSize === 'number',
        '`mapSize` must be a number.');
      assert(options.mapSize >= 0);
      this.mapSize = options.mapSize;
    }

    if (options.writeMap != null) {
      assert(typeof options.writeMap === 'boolean',
        '`writeMap` must be a boolean.');
      this.writeMap = options.writeMap;
    }

    if (options.noSubdir != null) {
      assert(typeof options.noSubdir === 'boolean',
        '`noSubdir` must be a boolean.');
      this.noSubdir = options.noSubdir;
    }

    return this;
  }
}

/**
 * Iterator Options
 */

class IteratorOptions {
  /**
   * Create iterator options.
   * @constructor
   * @ignore
   * @param {Object} options
   */

  constructor(options) {
    this.gte = null;
    this.lte = null;
    this.gt = null;
    this.lt = null;
    this.keys = true;
    this.values = false;
    this.fillCache = false;
    this.keyAsBuffer = true;
    this.valueAsBuffer = true;
    this.reverse = false;
    this.highWaterMark = 16 * 1024;

    // Note: do not add this property.
    // this.limit = null;

    if (options)
      this.fromOptions(options);
  }

  /**
   * Inject properties from options.
   * @private
   * @param {Object} options
   * @returns {IteratorOptions}
   */

  fromOptions(options) {
    assert(options, 'Options are required.');

    if (options.gte != null) {
      assert(Buffer.isBuffer(options.gte) || typeof options.gte === 'string');
      this.gte = options.gte;
    }

    if (options.lte != null) {
      assert(Buffer.isBuffer(options.lte) || typeof options.lte === 'string');
      this.lte = options.lte;
    }

    if (options.gt != null) {
      assert(Buffer.isBuffer(options.gt) || typeof options.gt === 'string');
      this.gt = options.gt;
    }

    if (options.lt != null) {
      assert(Buffer.isBuffer(options.lt) || typeof options.lt === 'string');
      this.lt = options.lt;
    }

    if (options.keys != null) {
      assert(typeof options.keys === 'boolean');
      this.keys = options.keys;
    }

    if (options.values != null) {
      assert(typeof options.values === 'boolean');
      this.values = options.values;
    }

    if (options.fillCache != null) {
      assert(typeof options.fillCache === 'boolean');
      this.fillCache = options.fillCache;
    }

    if (options.keyAsBuffer != null) {
      assert(typeof options.keyAsBuffer === 'boolean');
      this.keyAsBuffer = options.keyAsBuffer;
    }

    if (options.reverse != null) {
      assert(typeof options.reverse === 'boolean');
      this.reverse = options.reverse;
    }

    if (options.limit != null) {
      assert(typeof options.limit === 'number');
      assert(options.limit >= 0);
      this.limit = options.limit;
    }

    if (!this.keys && !this.values)
      throw new Error('Keys and/or values must be chosen.');

    return this;
  }
}

/*
 * Helpers
 */

function isNotFound(err) {
  if (!err)
    return false;

  return err.notFound
    || err.type === 'NotFoundError'
    || /not\s*found/i.test(err.message);
}

function wrap(resolve, reject) {
  return function(err, result) {
    if (err) {
      reject(err);
      return;
    }
    resolve(result);
  };
}

function slice(prefix, key) {
  if (!key || key.length === 0)
    return key;

  if (!prefix)
    return key;

  if (typeof key === 'string') {
    if (Buffer.isBuffer(prefix))
      prefix = prefix.toString('ascii');
    assert(typeof prefix === 'string');
    assert(key.length > prefix.length);
    return key.substring(prefix.length);
  }

  assert(Buffer.isBuffer(key));
  assert(key.length > prefix.length);

  return key.slice(prefix.length);
}

function concat(prefix, key) {
  if (!prefix)
    return key;

  if (typeof key === 'string') {
    if (Buffer.isBuffer(prefix))
      prefix = prefix.toString('ascii');
    assert(typeof prefix === 'string');
    return prefix + key;
  }

  assert(Buffer.isBuffer(key));

  const data = Buffer.allocUnsafe(prefix.length + key.length);

  if (typeof prefix === 'string') {
    data.write(prefix, 0, 'ascii');
  } else {
    assert(Buffer.isBuffer(prefix));
    prefix.copy(data, 0);
  }

  key.copy(data, prefix.length);

  return data;
}

function increment(key) {
  if (typeof key === 'string') {
    key = addOne(Buffer.from(key, 'utf8'));
    if (!key)
      return null;
    return key.toString('utf8');
  }
  return addOne(Buffer.from(key));
}

function addOne(key) {
  if (key.length === 0)
    return null;

  let i = key.length - 1;

  for (; i >= 0; i--) {
    if (key[i] !== 0xff) {
      key[i] += 1;
      break;
    }
    key[i] = 0;
  }

  if (i === 0)
    return null;

  return key;
}

VERSION_ERROR = 'Warning:'
  + ' Your database does not match the current database version.'
  + ' This is likely because the database layout or serialization'
  + ' format has changed drastically. If you want to dump your'
  + ' data, downgrade to your previous version first. If you do'
  + ' not think you should be seeing this error, post an issue on'
  + ' the repo.';

/*
 * Expose
 */

module.exports = LowLevelUp;